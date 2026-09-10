namespace RabiRoute.WindowsHost;

using System.Runtime.InteropServices;
using System.Text.Json;

public static class HostEntry
{
    [STAThread]
    public static async Task<int> RunAsync(string[] args, string packageRoot, string stateRoot)
    {
        var command = ParseCommand(args);
        var generationId = ParseOption(args, "--application-generation-id");
        var jsonOutput = args.Contains("--json", StringComparer.OrdinalIgnoreCase);
        if (jsonOutput) ConsoleBridge.AttachToParent();
        if (command == "self-test") return RunSelfTest();
        JsonElement? sourcePatch = null;
        var isWebPatch = SourcePatchTransport.IsWebCommand(command);
        if (SourcePatchTransport.IsCommand(command) || isWebPatch)
        {
            try { sourcePatch = SourcePatchTransport.ReadRequest(ParseOption(args, isWebPatch ? "--web-patch-request" : "--source-patch-request")); }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or ArgumentException or UnauthorizedAccessException)
            {
                if (jsonOutput) WriteJson(new HostResponse(false, "invalid_request", "Source patch request file could not be validated."));
                return 64;
            }
        }

        using var mutexLease = new NamedMutexLease(HostIdentity.MutexName);
        if (!mutexLease.OwnsMutex)
        {
            var response = await HostProtocol.SendAsync(
                command ?? "activate",
                generationId,
                command == "restart" ? TimeSpan.FromSeconds(210) : TimeSpan.FromSeconds(30),
                sourcePatch: isWebPatch ? null : sourcePatch,
                webPatch: isWebPatch ? sourcePatch : null);
            if (jsonOutput) WriteJson(response ?? new HostResponse(false, "unreachable", "The Host control pipe did not respond."));
            return response?.Ok == true ? 0 : 2;
        }

        if (command == "invalid")
        {
            if (jsonOutput) WriteJson(new HostResponse(false, "stopped", "Unknown Host command."));
            return 64;
        }
        if (command is "quit" or "restart" or "status" || SourcePatchTransport.IsCommand(command) || isWebPatch)
        {
            var staleFencedQuit = command == "quit" || SourcePatchTransport.IsCommand(command) || isWebPatch;
            var response = staleFencedQuit
                ? new HostResponse(false, "stale_generation", "No matching Host generation is running.")
                : new HostResponse(true, "stopped", "No Host instance is running.");
            if (jsonOutput) WriteJson(response);
            return response.Ok ? 0 : 3;
        }
        packageRoot = Path.GetFullPath(packageRoot);
        stateRoot = Path.GetFullPath(stateRoot);
        if (!LocalRuntimePath.IsLocal(packageRoot) || !LocalRuntimePath.IsLocal(stateRoot))
        {
            var response = new HostResponse(false, "invalid_root", "RabiRoute must run from a local Windows disk.");
            await using var rejectedLog = new HostLog();
            rejectedLog.Write($"rejected non-local runtime layout: packageRoot={packageRoot}; stateRoot={stateRoot}");
            if (jsonOutput) WriteJson(response);
            return 78;
        }
        var retiredEntries = PortableOverlayGuard.FindRetiredLifecycleEntriesForStartup(packageRoot, stateRoot);
        if (retiredEntries.Count > 0)
        {
            var message = PortableOverlayGuard.BlockedMessage(retiredEntries);
            var response = new HostResponse(false, "legacy_overlay_blocked", message);
            await using var rejectedLog = new HostLog();
            rejectedLog.Write($"rejected portable overlay with retired lifecycle entries: {string.Join(", ", retiredEntries)}");
            if (jsonOutput) WriteJson(response);
            else PortableOverlayGuard.ShowBlockedMessage(message);
            return 79;
        }
        using var cancellation = new CancellationTokenSource();
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        EventHandler exitHandler = (_, _) => cancellation.Cancel();
        Console.CancelKeyPress += cancelHandler;
        AppDomain.CurrentDomain.ProcessExit += exitHandler;
        try
        {
            var hostDiagnosticsRoot = Path.Combine(stateRoot, "logs", "host");
            await using var log = new HostLog(hostDiagnosticsRoot);
            return await new HostRuntime(
                packageRoot,
                stateRoot,
                log,
                new HostLifecycleAudit(hostDiagnosticsRoot)).RunAsync(cancellation.Token);
        }
        finally
        {
            Console.CancelKeyPress -= cancelHandler;
            AppDomain.CurrentDomain.ProcessExit -= exitHandler;
        }
    }

    internal static string? ParseCommand(string[] args)
    {
        if (args.Contains("--allow-unfenced-quit", StringComparer.OrdinalIgnoreCase)) return "invalid";
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index].Equals("--command", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= args.Length) return "invalid";
                var value = args[index + 1].Trim().ToLowerInvariant();
                return value is "quit" or "restart" or "status" or "activate" || SourcePatchTransport.IsCommand(value) || SourcePatchTransport.IsWebCommand(value) ? value : "invalid";
            }
        }
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase)) return "self-test";
        if (args.Any(argument =>
                argument.Equals("--quit", StringComparison.OrdinalIgnoreCase) ||
                argument.Equals("--restart", StringComparison.OrdinalIgnoreCase) ||
                argument.Equals("--status", StringComparison.OrdinalIgnoreCase) ||
                argument.Equals("--activate", StringComparison.OrdinalIgnoreCase))) return "invalid";
        if (args.Length > 0) return "invalid";
        return null;
    }

    private static string? ParseOption(string[] args, string name)
    {
        for (var index = 0; index < args.Length - 1; index++)
        {
            if (args[index].Equals(name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        }
        return null;
    }

    private static int RunSelfTest()
    {
        try
        {
            using var job = new WindowsJob($"self-test-{Environment.ProcessId}-{Guid.NewGuid():N}");
            return HostIdentity.PipeName.Length > 0 ? 0 : 1;
        }
        catch
        {
            return 1;
        }
    }

    private static void WriteJson(HostResponse response)
    {
        Console.WriteLine(JsonSerializer.Serialize(response, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }));
    }
}

internal static class PortableOverlayGuard
{
    private const uint MessageBoxOk = 0x00000000;
    private const uint MessageBoxIconError = 0x00000010;
    private static readonly string[] RetiredLifecycleEntries =
    {
        "RabiRoute-Desktop.exe",
        "RabiRoute-Tray.exe",
        "RabiRoute-Tray.new.exe",
        "Start-RabiRoute-Tray.bat",
        "Start-RabiRoute-Health-Watchdog.bat",
        "Start-RabiRoute-MessageAdapter-Watchdog.bat",
        Path.Combine("scripts", "Install-RabiRoute-HealthWatchdogTask.ps1"),
        Path.Combine("scripts", "watch-message-adapters.ps1"),
        Path.Combine("scripts", "watch-rabiroute-desktop-lifecycle.ps1"),
        Path.Combine("scripts", "watch-rabiroute-health-hidden.vbs"),
        Path.Combine("scripts", "watch-rabiroute-health.ps1")
    };

    internal static IReadOnlyList<string> FindRetiredLifecycleEntriesForStartup(
        string packageRoot,
        string stateRoot)
    {
        return new[] { Path.GetFullPath(packageRoot), Path.GetFullPath(stateRoot) }
            .SelectMany(FindRetiredLifecycleEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(relativePath => relativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static IReadOnlyList<string> FindRetiredLifecycleEntries(string root)
    {
        var fullRoot = Path.GetFullPath(root);
        return RetiredLifecycleEntries
            .Where(relativePath => File.Exists(Path.Combine(fullRoot, relativePath)))
            .Select(relativePath => relativePath.Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(relativePath => relativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static string BlockedMessage(IReadOnlyList<string> retiredEntries) =>
        "RabiRoute refused to start because this folder still contains retired lifecycle entries: " +
        $"{string.Join(", ", retiredEntries)}. Do not extract the portable ZIP over an older installation. " +
        "Extract it to a new empty folder, or run the Windows Setup package to migrate the existing installation safely.";

    internal static void ShowBlockedMessage(string message)
    {
        try
        {
            MessageBoxW(IntPtr.Zero, message, "RabiRoute cannot start", MessageBoxOk | MessageBoxIconError);
        }
        catch
        {
            // The JSON response and Host log remain the diagnostic contract when UI presentation is unavailable.
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
}

internal static class LocalRuntimePath
{
    internal static bool IsLocal(string path)
    {
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return false;
        var root = Path.GetPathRoot(path);
        if (string.IsNullOrWhiteSpace(root)) return false;
        try { return new DriveInfo(root).DriveType != DriveType.Network; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
}

internal sealed class NamedMutexLease : IDisposable
{
    private readonly ManualResetEventSlim _initialized = new(false);
    private readonly ManualResetEventSlim _release = new(false);
    private readonly Thread _ownerThread;

    internal NamedMutexLease(string name)
    {
        _ownerThread = new Thread(() => OwnMutex(name))
        {
            IsBackground = false,
            Name = "RabiRoute Host single-instance Mutex owner"
        };
        _ownerThread.Start();
        _initialized.Wait();
    }

    internal bool OwnsMutex { get; private set; }

    private void OwnMutex(string name)
    {
        using var mutex = new Mutex(false, name);
        try { OwnsMutex = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { OwnsMutex = true; }
        finally { _initialized.Set(); }
        if (!OwnsMutex) return;
        _release.Wait();
        mutex.ReleaseMutex();
    }

    public void Dispose()
    {
        _release.Set();
        _ownerThread.Join();
        _release.Dispose();
        _initialized.Dispose();
    }
}

internal static class ConsoleBridge
{
    private const uint AttachParentProcess = 0xFFFFFFFF;

    internal static void AttachToParent()
    {
        NativeMethods.AttachConsole(AttachParentProcess);
        try
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
        }
        catch (IOException) { }
    }
}
