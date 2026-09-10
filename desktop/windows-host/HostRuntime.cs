using System.Diagnostics;
using System.ComponentModel;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace RabiRoute.WindowsHost;

internal sealed record ManagerReady(
    [property: JsonPropertyName("protocolVersion")] int ProtocolVersion,
    [property: JsonPropertyName("applicationGenerationId")] string ApplicationGenerationId,
    [property: JsonPropertyName("managerInstanceId")] string ManagerInstanceId,
    [property: JsonPropertyName("pid")] uint Pid,
    [property: JsonPropertyName("baseUrl")] string BaseUrl,
    [property: JsonPropertyName("readyAt")] string ReadyAt);

internal static class ManagerReadiness
{
    internal const string Prefix = "RABIROUTE_MANAGER_READY:";

    internal static ManagerReady? Parse(string line, string expectedGenerationId, uint expectedPid)
    {
        if (!line.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        ManagerReady? ready;
        try
        {
            ready = JsonSerializer.Deserialize<ManagerReady>(line[Prefix.Length..]);
        }
        catch (JsonException)
        {
            return null;
        }
        if (ready is null ||
            ready.ProtocolVersion != 1 ||
            ready.ApplicationGenerationId != expectedGenerationId ||
            ready.Pid != expectedPid ||
            string.IsNullOrWhiteSpace(ready.ManagerInstanceId) ||
            !DateTimeOffset.TryParse(ready.ReadyAt, out _) ||
            !Uri.TryCreate(ready.BaseUrl, UriKind.Absolute, out var endpoint) ||
            endpoint.Scheme != Uri.UriSchemeHttp ||
            !System.Net.IPAddress.TryParse(endpoint.Host, out var address) ||
            !System.Net.IPAddress.IsLoopback(address) ||
            endpoint.Port <= 0)
        {
            return null;
        }
        return ready;
    }
}

internal static class StableNodeRuntime
{
    internal const string RuntimeDirectoryName = "runtime";
    internal const string RuntimeFileName = "node.exe";

    internal static string Resolve(string packageRoot, string stateRoot)
    {
        var packaged = Path.GetFullPath(Path.Combine(packageRoot, RuntimeFileName));
        RequireRegularFile(packaged, "versioned Node.js runtime");

        var stableRoot = Path.GetFullPath(Path.Combine(stateRoot, RuntimeDirectoryName));
        var expectedStableRoot = Path.Combine(Path.GetFullPath(stateRoot), RuntimeDirectoryName);
        if (!string.Equals(stableRoot, expectedStableRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The stable Node.js runtime path escaped the RabiRoute state root.");

        if (Directory.Exists(stableRoot)) RequireRegularDirectory(stableRoot, "stable runtime directory");
        else Directory.CreateDirectory(stableRoot);
        RequireRegularDirectory(stableRoot, "stable runtime directory");

        var stable = Path.Combine(stableRoot, RuntimeFileName);
        if (File.Exists(stable))
        {
            RequireRegularFile(stable, "stable Node.js runtime");
            if (FilesMatch(packaged, stable)) return stable;
        }

        var temporary = Path.Combine(stableRoot, $".{RuntimeFileName}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var source = new FileStream(packaged, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var destination = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                1024 * 1024,
                FileOptions.WriteThrough))
            {
                source.CopyTo(destination);
                destination.Flush(flushToDisk: true);
            }
            if (!FilesMatch(packaged, temporary))
                throw new InvalidDataException("The stable Node.js runtime copy did not match the validated release runtime.");
            File.Move(temporary, stable, overwrite: true);
            RequireRegularFile(stable, "stable Node.js runtime");
            return stable;
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    private static bool FilesMatch(string left, string right)
    {
        var leftInfo = new FileInfo(left);
        var rightInfo = new FileInfo(right);
        if (leftInfo.Length != rightInfo.Length) return false;
        using var leftStream = File.OpenRead(left);
        using var rightStream = File.OpenRead(right);
        return System.Security.Cryptography.SHA256.HashData(leftStream)
            .AsSpan()
            .SequenceEqual(System.Security.Cryptography.SHA256.HashData(rightStream));
    }

    private static void RequireRegularDirectory(string path, string label)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"The {label} is missing: {path}");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"The {label} must not be a reparse point.");
    }

    private static void RequireRegularFile(string path, string label)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"The {label} is missing.", path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"The {label} must not be a reparse point.");
    }
}

internal sealed class HostLog : IAsyncDisposable
{
    private const long DefaultMaximumFileBytes = 2 * 1024 * 1024;
    private const int RetainedFileCount = 4;
    private readonly string _root;
    private readonly long _maximumFileBytes;
    private readonly Channel<string> _entries;
    private readonly Task _writer;

    internal HostLog(string? root = null, long maximumFileBytes = DefaultMaximumFileBytes)
    {
        _root = root ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RabiRoute",
            "diagnostics",
            "host");
        _maximumFileBytes = Math.Max(1024, maximumFileBytes);
        _entries = Channel.CreateBounded<string>(new BoundedChannelOptions(1024)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest,
            AllowSynchronousContinuations = false
        });
        _writer = Task.Run(WriterLoopAsync);
    }

    internal void Write(string message)
    {
        try
        {
            _entries.Writer.TryWrite($"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch
        {
            // Diagnostics are best-effort and must never become lifecycle authority.
        }
    }

    private async Task WriterLoopAsync()
    {
        try
        {
            while (await _entries.Reader.WaitToReadAsync())
            {
                var batch = new System.Text.StringBuilder();
                while (_entries.Reader.TryRead(out var entry) && batch.Length < 64 * 1024)
                {
                    batch.Append(entry);
                }
                if (batch.Length == 0) continue;
                try
                {
                    Directory.CreateDirectory(_root);
                    var path = Path.Combine(_root, $"host-{DateTimeOffset.Now:yyyyMMdd}.log");
                    var text = batch.ToString();
                    RotateIfNeeded(path, System.Text.Encoding.UTF8.GetByteCount(text));
                    await File.AppendAllTextAsync(path, text, System.Text.Encoding.UTF8);
                }
                catch
                {
                    // Disk exhaustion, ACL failures and transient filesystem stalls are
                    // isolated from the Host. The bounded channel caps memory use.
                    await Task.Delay(TimeSpan.FromMilliseconds(250));
                }
            }
        }
        catch
        {
            // No logging failure may terminate or stall the lifecycle owner.
        }
    }

    private void RotateIfNeeded(string path, int incomingBytes)
    {
        if (!File.Exists(path) || new FileInfo(path).Length + incomingBytes <= _maximumFileBytes) return;
        for (var index = RetainedFileCount - 1; index >= 1; index--)
        {
            var source = index == 1 ? path : $"{path}.{index - 1}";
            var destination = $"{path}.{index}";
            if (File.Exists(source)) File.Move(source, destination, true);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { _entries.Writer.TryComplete(); } catch { }
        try { await Task.WhenAny(_writer, Task.Delay(TimeSpan.FromSeconds(2))); } catch { }
    }
}

internal sealed class ApplicationGeneration : IAsyncDisposable
{
    internal static readonly TimeSpan ManagerReadyTimeout = TimeSpan.FromMinutes(3);
    internal static readonly TimeSpan TrayReadyTimeout = TimeSpan.FromMinutes(2);

    private static readonly TimeSpan HealthProbeInterval = TimeSpan.FromSeconds(2);
    private const int ConsecutiveProbeFailureLimit = 3;
    private readonly WindowsJob _job;
    private readonly NativeChildProcess _manager;
    private readonly NativeChildProcess _tray;
    private readonly Task<int> _managerExit;
    private readonly Task<int> _trayExit;
    private readonly TrayLifecycleChannel _trayLifecycle;
    private readonly HostLog _log;
    private readonly string _controlToken;
    private readonly TrayReady _trayReady;
    private readonly ManagerLifecycleClient _managerLifecycle = new();
    private readonly CancellationTokenSource _monitorCancellation = new();
    private readonly Action<string> _healthChanged;
    private readonly Action<string> _failureObserved;
    private volatile string _healthState = "healthy";
    private int _stopping;
    private int _disposed;

    private ApplicationGeneration(
        string id,
        ManagerReady ready,
        WindowsJob job,
        NativeChildProcess manager,
        NativeChildProcess tray,
        Task<int> managerExit,
        Task<int> trayExit,
        TrayLifecycleChannel trayLifecycle,
        TrayReady trayReady,
        string controlToken,
        Action<string> healthChanged,
        Action<string> failureObserved,
        HostLog log)
    {
        Id = id;
        Ready = ready;
        _job = job;
        _manager = manager;
        _tray = tray;
        _managerExit = managerExit;
        _trayExit = trayExit;
        _trayLifecycle = trayLifecycle;
        _trayReady = trayReady;
        _controlToken = controlToken;
        _healthChanged = healthChanged;
        _failureObserved = failureObserved;
        _log = log;
        Failure = ObserveFailureSafelyAsync();
    }

    internal string Id { get; }
    internal ManagerReady Ready { get; }
    internal Task<string> Failure { get; }
    internal string HealthState => _healthState;
    internal Task<HostResponse> ForwardSourcePatchAsync(JsonElement payload, bool reconcile, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _stopping) != 0)
            return Task.FromResult(new HostResponse(false, "source_patch_unconfirmed", "The source patch generation is stopping; query the original operation."));
        return SourcePatchTransport.SendAsync(Ready, _controlToken, payload, reconcile, cancellationToken);
    }
    internal uint TrayPid => _tray.ProcessId;
    internal string TrayBoundManagerInstanceId => _trayReady.ManagerInstanceId;
    internal IReadOnlyList<uint> JobMemberPids
    {
        get
        {
            try { return _job.MemberProcessIds(); }
            catch (ObjectDisposedException) { return Array.Empty<uint>(); }
            catch (InvalidOperationException) { return Array.Empty<uint>(); }
            catch (Win32Exception) { return Array.Empty<uint>(); }
        }
    }

    internal static IReadOnlyList<string> BuildTrayArguments(
        string trayMain,
        ManagerReady ready,
        string generationId,
        string hostExecutable,
        string lifecyclePipe) =>
        new[]
        {
            "-B",
            trayMain,
            "--surface-child",
            "--manager-url", ready.BaseUrl,
            "--application-generation-id", generationId,
            "--manager-instance-id", ready.ManagerInstanceId,
            "--host-executable", hostExecutable,
            "--host-lifecycle-pipe", lifecyclePipe
        };

    internal static IReadOnlyDictionary<string, string?> BuildTrayEnvironment(
        string packageRoot,
        string stateRoot,
        string generationId) =>
        new Dictionary<string, string?>
        {
            ["PYTHONDONTWRITEBYTECODE"] = "1",
            ["RABIROUTE_HOSTED"] = "1",
            ["RABIROUTE_APPLICATION_GENERATION_ID"] = generationId,
            ["RABIROUTE_HOST_CONTROL_TOKEN"] = null,
            ["RABIROUTE_PACKAGE_ROOT"] = packageRoot,
            ["RABIROUTE_STATE_ROOT"] = stateRoot
        };

    internal static async Task<ApplicationGeneration> StartAsync(
        string packageRoot,
        string stateRoot,
        string generationId,
        HostLog log,
        Action<string> healthChanged,
        Action<string> failureObserved,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(generationId)) throw new ArgumentException("Application generation id is required.", nameof(generationId));
        var controlToken = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var job = new WindowsJob(generationId);
        NativeChildProcess? manager = null;
        NativeChildProcess? tray = null;
        TrayLifecycleChannel? trayLifecycle = null;
        try
        {
            var node = StableNodeRuntime.Resolve(packageRoot, stateRoot);
            log.Write($"generation={generationId} stable Node.js runtime={node}");
            var managerEntry = Path.Combine(packageRoot, "dist", "manager.js");
            if (!File.Exists(managerEntry)) throw new FileNotFoundException("Manager build is missing.", managerEntry);
            var managerPortPolicy = ManagerPortPreference.ResolveStartupPolicy(stateRoot, log);
            manager = NativeChildProcess.StartSuspendedInJob(
                job,
                node,
                new[] { managerEntry },
                stateRoot,
                new Dictionary<string, string?>
                {
                    ["GATEWAY_MANAGER_PORT"] = managerPortPolicy,
                     ["RABIROUTE_HOSTED"] = "1",
                     ["RABIROUTE_APPLICATION_GENERATION_ID"] = generationId,
                     ["RABIROUTE_HOST_CONTROL_TOKEN"] = controlToken,
                     ["RABIROUTE_MANAGER_INSTANCE_LOCK_DIR"] = null,
                     ["RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE"] = null,
                     ["RABIROUTE_MANAGER_ACCEPTANCE_MODE"] = null,
                     ["RABIROUTE_PACKAGE_ROOT"] = packageRoot,
                     ["RABIROUTE_STATE_ROOT"] = stateRoot
                 });
            log.Write($"generation={generationId} manager pid={manager.ProcessId} started suspended, assigned to Job, then resumed");

            var readiness = new TaskCompletionSource<ManagerReady>(TaskCreationOptions.RunContinuationsAsynchronously);
            var managerOutput = PumpManagerOutputAsync(manager, generationId, readiness, log);
            var managerErrors = PumpLinesAsync(manager.StandardError, "manager stderr", generationId, log);
            var managerExit = manager.WaitForExitAsync(cancellationToken);
            var timeout = Task.Delay(ManagerReadyTimeout, cancellationToken);
            var first = await Task.WhenAny(readiness.Task, managerExit, timeout);
            cancellationToken.ThrowIfCancellationRequested();
            if (first == managerExit)
            {
                throw new InvalidOperationException($"Manager exited before READY with code {await managerExit}.");
            }
            if (first == timeout)
            {
                throw new TimeoutException($"Manager did not publish structured READY within {ManagerReadyTimeout.TotalSeconds:0} seconds.");
            }
            var ready = await readiness.Task;
            log.Write($"generation={generationId} manager READY instance={ready.ManagerInstanceId} endpoint={ready.BaseUrl}");

            using (var admission = new ManagerLifecycleClient())
            {
                var admissionDeadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(30);
                ManagerProbeResult? lastProbe = null;
                while (DateTimeOffset.UtcNow < admissionDeadline)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (manager.HasExited)
                    {
                        throw new InvalidOperationException("Manager exited before required-readiness admission.");
                    }
                    lastProbe = await admission.ProbeAsync(ready, generationId, cancellationToken);
                    if (lastProbe.State is ManagerProbeState.Healthy or ManagerProbeState.Degraded)
                    {
                        log.Write($"generation={generationId} Manager required-readiness admitted state={lastProbe.State}");
                        break;
                    }
                    await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
                }
                if (lastProbe?.State is not (ManagerProbeState.Healthy or ManagerProbeState.Degraded))
                {
                    throw new InvalidOperationException($"Manager did not pass required-readiness admission: {lastProbe?.Message ?? "no health response"}");
                }
            }

            var trayExecutable = Path.Combine(packageRoot, "desktop-runtime", "python", "pythonw.exe");
            var trayMain = Path.Combine(packageRoot, "desktop-runtime", "main.py");
            if (!File.Exists(trayExecutable)) throw new FileNotFoundException("Qt runtime is missing.", trayExecutable);
            if (!File.Exists(trayMain)) throw new FileNotFoundException("Qt entry is missing.", trayMain);
            trayLifecycle = new TrayLifecycleChannel(generationId);
            tray = NativeChildProcess.StartSuspendedInJob(
                job,
                trayExecutable,
                BuildTrayArguments(
                    trayMain,
                    ready,
                    generationId,
                    Environment.ProcessPath ?? Path.Combine(stateRoot, "RabiRouteHost.exe"),
                    trayLifecycle.PipeName),
                stateRoot,
                BuildTrayEnvironment(packageRoot, stateRoot, generationId));
            _ = PumpLinesAsync(tray.StandardOutput, "tray stdout", generationId, log);
            _ = PumpLinesAsync(tray.StandardError, "tray stderr", generationId, log);
            var trayExit = tray.WaitForExitAsync(cancellationToken);
            var trayReady = trayLifecycle.WaitForReadyAsync(
                generationId,
                ready.ManagerInstanceId,
                tray.ProcessId,
                TrayReadyTimeout,
                cancellationToken);
            var trayFirst = await Task.WhenAny(managerExit, trayExit, trayReady);
            cancellationToken.ThrowIfCancellationRequested();
            if (trayFirst == managerExit)
            {
                throw new InvalidOperationException($"Manager exited while waiting for Tray READY with code {await managerExit}.");
            }
            if (trayFirst == trayExit)
            {
                throw new InvalidOperationException($"Tray exited before publishing exact Host lifecycle READY with code {await trayExit}.");
            }
            var acceptedTrayReady = await trayReady;
            if (acceptedTrayReady is null)
            {
                throw new TimeoutException($"Tray did not publish exact Host lifecycle READY within {TrayReadyTimeout.TotalSeconds:0} seconds.");
            }
            if (manager.HasExited || tray.HasExited)
            {
                throw new InvalidOperationException("Manager or Tray exited during final generation admission.");
            }
            using (var finalAdmission = new ManagerLifecycleClient())
            {
                var admissionDeadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(30);
                ManagerProbeResult? finalProbe = null;
                do
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (manager.HasExited || tray.HasExited) break;
                    finalProbe = await finalAdmission.ProbeAsync(ready, generationId, cancellationToken);
                    if (finalProbe.State is ManagerProbeState.Healthy or ManagerProbeState.Degraded) break;
                    await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
                } while (DateTimeOffset.UtcNow < admissionDeadline);
                if (finalProbe?.State is not (ManagerProbeState.Healthy or ManagerProbeState.Degraded) ||
                    manager.HasExited || tray.HasExited)
                {
                    throw new InvalidOperationException($"Manager failed final generation admission: {finalProbe?.Message ?? "process exited"}");
                }
            }
            ManagerPortPreference.SaveSuccessfulEndpoint(stateRoot, ready.BaseUrl, log);
            log.Write($"generation={generationId} tray pid={tray.ProcessId} published exact lifecycle READY after exact Manager READY");
            return new ApplicationGeneration(
                generationId,
                ready,
                job,
                manager,
                tray,
                managerExit,
                trayExit,
                trayLifecycle,
                acceptedTrayReady,
                controlToken,
                healthChanged,
                failureObserved,
                log);
        }
        catch (Exception exception)
        {
            try { job.Terminate(); } catch (Exception cleanupError) { log.Write($"generation={generationId} startup Job cleanup failed: {cleanupError.Message}"); }
            try { tray?.Dispose(); } catch (Exception cleanupError) { log.Write($"generation={generationId} startup Tray cleanup failed: {cleanupError.Message}"); }
            try { manager?.Dispose(); } catch (Exception cleanupError) { log.Write($"generation={generationId} startup Manager cleanup failed: {cleanupError.Message}"); }
            try { if (trayLifecycle is not null) await trayLifecycle.DisposeAsync(); } catch (Exception cleanupError) { log.Write($"generation={generationId} startup Tray channel cleanup failed: {cleanupError.Message}"); }
            try { job.Dispose(); } catch (Exception cleanupError) { log.Write($"generation={generationId} startup Job dispose failed: {cleanupError.Message}"); }
            if (cancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException("Application generation startup was canceled.", exception, cancellationToken);
            }
            throw;
        }
    }

    internal async Task StopAsync(string reason)
    {
        if (Interlocked.Exchange(ref _stopping, 1) != 0) return;
        _log.Write($"generation={Id} stopping reason={reason}");
        _monitorCancellation.Cancel();
        try
        {
            if (!_tray.HasExited)
            {
                var sent = await _trayLifecycle.RequestShutdownAsync(TimeSpan.FromSeconds(3), CancellationToken.None);
                _log.Write($"generation={Id} Tray graceful shutdown sent={sent}");
                if (sent)
                {
                    await Task.WhenAny(_tray.WaitForExitAsync(), Task.Delay(TimeSpan.FromSeconds(5)));
                }
            }
        }
        catch (Exception exception)
        {
            _log.Write($"generation={Id} graceful tray close failed: {exception.Message}");
        }
        try
        {
            if (!_manager.HasExited)
            {
                var accepted = await _managerLifecycle.RequestShutdownAsync(Ready, _controlToken, CancellationToken.None);
                _log.Write($"generation={Id} Manager graceful shutdown accepted={accepted}");
                if (accepted)
                {
                    await Task.WhenAny(_manager.WaitForExitAsync(), Task.Delay(TimeSpan.FromSeconds(12)));
                }
            }
        }
        catch (Exception exception)
        {
            _log.Write($"generation={Id} Manager graceful shutdown failed: {exception.Message}");
        }
        try
        {
            if (!_manager.HasExited || !_tray.HasExited)
            {
                _log.Write($"generation={Id} forcing remaining generation processes through the Job boundary");
                _job.Terminate(reason == "explicit-quit" ? 0u : 1u);
            }
        }
        catch (Exception exception) { _log.Write($"generation={Id} job termination failed: {exception.Message}"); }
    }

    private async Task<string> ObserveFailureAsync()
    {
        var unhealthy = ObserveManagerHealthAsync(_monitorCancellation.Token);
        var completed = await Task.WhenAny(_managerExit, _trayExit, unhealthy);
        if (completed == unhealthy) return await unhealthy;
        return completed == _managerExit
            ? $"manager-exited:{await _managerExit}"
            : $"tray-exited:{await _trayExit}";
    }

    private async Task<string> ObserveFailureSafelyAsync()
    {
        string reason;
        try { reason = await ObserveFailureAsync(); }
        catch (OperationCanceledException) when (_monitorCancellation.IsCancellationRequested)
        {
            reason = "generation-monitor-cancelled";
        }
        catch (Exception exception)
        {
            reason = $"generation-monitor-failed:{exception.GetType().Name}:{exception.Message}";
        }
        _failureObserved(reason);
        return reason;
    }

    private async Task<string> ObserveManagerHealthAsync(CancellationToken cancellationToken)
    {
        var consecutiveFailures = 0;
        string? lastFailure = null;
        string? loggedState = null;
        while (true)
        {
            await Task.Delay(HealthProbeInterval, cancellationToken);
            var probe = await _managerLifecycle.ProbeAsync(Ready, Id, cancellationToken);
            if (probe.State == ManagerProbeState.Failed)
            {
                consecutiveFailures++;
                lastFailure = probe.Message;
                _log.Write($"generation={Id} Manager health probe failed {consecutiveFailures}/{ConsecutiveProbeFailureLimit}: {probe.Message}");
                if (consecutiveFailures >= ConsecutiveProbeFailureLimit)
                {
                    return $"manager-unhealthy:{lastFailure}";
                }
                continue;
            }

            consecutiveFailures = 0;
            lastFailure = null;
                _healthState = probe.State == ManagerProbeState.Degraded ? "degraded" : "healthy";
                _healthChanged(_healthState);
            if (!string.Equals(loggedState, _healthState, StringComparison.Ordinal))
            {
                _log.Write($"generation={Id} Manager health state={_healthState}");
                loggedState = _healthState;
            }
        }
    }

    private static async Task PumpManagerOutputAsync(
        NativeChildProcess manager,
        string generationId,
        TaskCompletionSource<ManagerReady> readiness,
        HostLog log)
    {
        try
        {
            while (await manager.StandardOutput.ReadLineAsync() is { } line)
            {
                log.Write($"generation={generationId} manager stdout: {line}");
                var parsed = ManagerReadiness.Parse(line, generationId, manager.ProcessId);
                if (parsed is not null) readiness.TrySetResult(parsed);
            }
        }
        catch (ObjectDisposedException) { }
        catch (IOException exception) { log.Write($"generation={generationId} manager stdout closed: {exception.Message}"); }
    }

    private static async Task PumpLinesAsync(StreamReader reader, string source, string generationId, HostLog log)
    {
        try
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                log.Write($"generation={generationId} {source}: {line}");
            }
        }
        catch (ObjectDisposedException) { }
        catch (IOException exception) { log.Write($"generation={generationId} {source} closed: {exception.Message}"); }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { _monitorCancellation.Cancel(); } catch { }
        try { _managerLifecycle.Dispose(); } catch { }
        try { await _trayLifecycle.DisposeAsync(); } catch { }
        try { _tray.Dispose(); } catch { }
        try { _manager.Dispose(); } catch { }
        try { _job.Dispose(); } catch { }
        try { _monitorCancellation.Dispose(); } catch { }
    }
}

internal sealed record QueuedCommand(
    string Command,
    string? ApplicationGenerationId,
    HostOperationContext Operation,
    TaskCompletionSource<HostResponse> Completion,
    TaskCompletionSource<bool> ResponseSent,
    JsonElement? SourcePatch = null);

internal sealed record PendingTransition(
    HostOperationContext Operation,
    QueuedCommand? ClientCommand,
    string? RequestedGenerationId,
    bool AuditPersisted);

internal sealed record LifecyclePublication(
    string State,
    string? ControlFenceGenerationId,
    string? ApplicationGenerationId = null,
    string? ManagerInstanceId = null,
    string? ManagerBaseUrl = null,
    uint? ManagerPid = null,
    uint? TrayPid = null,
    string? TrayBoundManagerInstanceId = null,
    IReadOnlyList<uint>? JobMemberPids = null);

internal static class GenerationFence
{
    internal static bool AllowsQuit(string? activeGenerationId, string? requestedGenerationId) =>
        !string.IsNullOrWhiteSpace(activeGenerationId) &&
         !string.IsNullOrWhiteSpace(requestedGenerationId) &&
         string.Equals(requestedGenerationId, activeGenerationId, StringComparison.Ordinal);
}

internal sealed class HostRuntime
{
    private static readonly TimeSpan[] RestartBackoff =
    {
        TimeSpan.FromSeconds(1),
        TimeSpan.FromSeconds(2),
        TimeSpan.FromSeconds(4),
        TimeSpan.FromSeconds(8),
        TimeSpan.FromSeconds(16)
    };

    private readonly string _packageRoot;
    private readonly string _stateRoot;
    private readonly HostLog _log;
    private readonly IHostLifecycleAudit _audit;
    private readonly Channel<QueuedCommand> _commands = Channel.CreateUnbounded<QueuedCommand>();
    private readonly ConcurrentDictionary<string, QueuedCommand> _acceptedMutations = new(StringComparer.Ordinal);
    private readonly object _mutationAcceptanceGate = new();
    private readonly RestartFailureWindow _failureWindow = new(RestartBackoff.Length, RestartFailureWindow.DefaultWindow);
    private readonly object _publicationGate = new();
    private readonly ConditionalWeakTable<HostOperationContext, TerminalAuditMarker> _terminalAuditOperations = new();
    private string _state = "starting";
    private ApplicationGeneration? _generation;
    private PendingTransition? _pendingTransition;
    private string? _fenceGenerationId;
    private volatile LifecyclePublication _publication = new("starting", null, null);
    private bool _acceptingMutations = true;
    private int _sourcePatchInFlight;

    internal HostRuntime(string packageRoot, string stateRoot, HostLog log, IHostLifecycleAudit? audit = null)
    {
        _packageRoot = packageRoot;
        _stateRoot = stateRoot;
        _log = log;
        _audit = audit ?? new HostLifecycleAudit();
    }

    internal async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        using var controlAcceptCancellation = new CancellationTokenSource();
        using var controlHandlerCancellation = new CancellationTokenSource();
        var controlServer = RunControlServerAsync(controlAcceptCancellation.Token, controlHandlerCancellation.Token);
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    PublishState("starting");
                    var startup = await StartGenerationOrCommandAsync(cancellationToken);
                    if (startup.Command == "quit") return 0;
                    if (startup.Command == "restart")
                    {
                        _failureWindow.Clear();
                        continue;
                    }
                    var admittedGeneration = startup.Generation ?? throw new InvalidOperationException("Generation startup returned no result.");
                    if (admittedGeneration.Failure.IsCompleted)
                    {
                        await StopAndDisposeGenerationAsync(admittedGeneration, "generation-failed-at-ready-admission");
                        throw new InvalidOperationException($"Generation failed at READY admission: {await admittedGeneration.Failure}");
                    }
                    if (!AdoptGeneration(admittedGeneration))
                    {
                        await StopAndDisposeGenerationAsync(admittedGeneration, "generation-failed-after-ready-admission");
                        throw new InvalidOperationException($"Generation failed immediately after READY admission: {await admittedGeneration.Failure}");
                    }
                    if (_pendingTransition is not null)
                    {
                        var transition = _pendingTransition;
                        var startedPersisted = transition.ClientCommand is null
                            ? AppendTerminalAudit(
                                transition.Operation,
                                "restart",
                                "replacement_generation_ready",
                                transition.RequestedGenerationId,
                                "completed",
                                CurrentState())
                            : AppendAudit(
                                transition.Operation,
                                "transition_ready",
                                "restart",
                                "replacement_generation_ready",
                                transition.RequestedGenerationId,
                                "ready",
                                CurrentState(),
                                ElapsedMilliseconds(transition.Operation));
                        _pendingTransition = null;
                        transition.ClientCommand?.Completion.TrySetResult(
                            CurrentResponse(true, "The replacement application generation is ready.") with
                            {
                                AuditPersisted = transition.AuditPersisted && startedPersisted
                            });
                    }
                    var outcome = await WaitForCommandOrFailureAsync(admittedGeneration, cancellationToken);
                    if (outcome == "quit") return 0;
                    if (outcome == "restart")
                    {
                        _failureWindow.Clear();
                        continue;
                    }
                    var failures = _failureWindow.Record(DateTimeOffset.UtcNow);
                    if (_failureWindow.IsOpen(DateTimeOffset.UtcNow))
                    {
                        PublishState("faulted");
                        FailPendingTransition("replacement_generation_circuit_open");
                        _log.Write($"restart circuit opened after {failures} failed generations");
                        var faultCommand = await WaitInFaultedStateAsync(cancellationToken);
                        if (faultCommand == "quit") return 0;
                        _failureWindow.Clear();
                        continue;
                    }
                    PublishState("backoff");
                    _log.Write($"generation failed; bounded restart {failures}/{RestartBackoff.Length} in {RestartBackoff[failures - 1].TotalSeconds}s");
                    var interrupted = await WaitBackoffOrCommandAsync(RestartBackoff[failures - 1], cancellationToken);
                    if (interrupted == "quit") return 0;
                    if (interrupted == "restart") _failureWindow.Clear();
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    await CompletePendingForHostShutdownAsync("host_cancellation");
                    if (_generation is not null)
                    {
                        await StopAndDisposeGenerationAsync(_generation, "host-cancellation");
                    }
                    return 0;
                }
                catch (Exception exception)
                {
                    _log.Write($"generation start failed: {exception}");
                    if (_generation is not null)
                    {
                        await StopAndDisposeGenerationAsync(_generation, "generation-admission-failed");
                    }
                    if (_pendingTransition is not null)
                    {
                        var transition = _pendingTransition;
                        var persisted = AppendAudit(transition.Operation, "generation_start_failed", "restart", "replacement_generation_failed", transition.RequestedGenerationId, "recovering", _state, ElapsedMilliseconds(transition.Operation));
                        _pendingTransition = transition with { AuditPersisted = transition.AuditPersisted && persisted };
                        if (transition.ClientCommand is not null)
                        {
                            FailPendingTransition("replacement_generation_start_failed");
                            BeginInternalRecovery("client_replacement_failed");
                        }
                    }
                    var failures = _failureWindow.Record(DateTimeOffset.UtcNow);
                    if (_failureWindow.IsOpen(DateTimeOffset.UtcNow))
                    {
                        PublishState("faulted");
                        FailPendingTransition("replacement_generation_start_circuit_open");
                        _log.Write($"restart circuit opened after {failures} failed generation starts");
                        var faultCommand = await WaitInFaultedStateAsync(cancellationToken);
                        if (faultCommand == "quit") return 0;
                        _failureWindow.Clear();
                    }
                    else
                    {
                        PublishState("backoff");
                        var interrupted = await WaitBackoffOrCommandAsync(RestartBackoff[failures - 1], cancellationToken);
                        if (interrupted == "quit") return 0;
                        if (interrupted == "restart") _failureWindow.Clear();
                    }
                }
                finally
                {
                    if (_generation is not null)
                    {
                        await StopAndDisposeGenerationAsync(_generation, "host-loop-finally");
                    }
                }
            }
            return 0;
        }
        finally
        {
            controlAcceptCancellation.Cancel();
            lock (_mutationAcceptanceGate) _acceptingMutations = false;
            await CompletePendingForHostShutdownAsync("host_shutdown");
            await CompleteAcceptedMutationsForHostShutdownAsync("host_shutdown");
            if (await Task.WhenAny(controlServer, Task.Delay(TimeSpan.FromSeconds(7))) != controlServer)
            {
                controlHandlerCancellation.Cancel();
            }
            try { await controlServer; } catch (OperationCanceledException) { }
        }
    }

    private async Task<(ApplicationGeneration? Generation, string? Command)> StartGenerationOrCommandAsync(
        CancellationToken cancellationToken)
    {
        using var startupCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var startupGenerationId = Guid.NewGuid().ToString("N");
        _fenceGenerationId = startupGenerationId;
        RefreshPublication();
        var startup = ApplicationGeneration.StartAsync(
            _packageRoot,
            _stateRoot,
            startupGenerationId,
            _log,
            health => PublishGenerationHealth(startupGenerationId, health),
            reason => PublishGenerationFailure(startupGenerationId, reason),
            startupCancellation.Token);
        while (true)
        {
            var next = await AwaitStartupOrCommandAsync(startup, _commands.Reader, cancellationToken);
            if (next.StartupCompleted)
            {
                return (await startup, null);
            }

            var command = next.Command!;
            if (command.Command == "quit")
            {
                if (!CanQuit(command))
                {
                    command.Completion.TrySetResult(Response(false, "stale_generation", "There is no matching active application generation."));
                    continue;
                }
                await CancelPendingTransitionAsync("fenced_quit_during_startup");
                await CancelAndDisposeStartupAsync(startup, startupCancellation, "explicit-quit");
                PublishState("stopped");
                command.Completion.TrySetResult(Response(true, _state));
                await WaitForResponseSentAsync(command);
                return (null, "quit");
            }
            if (command.Command == "restart")
            {
                if (!CanQuit(command))
                {
                    command.Completion.TrySetResult(Response(false, "stale_generation", "There is no matching active application generation."));
                    continue;
                }
                BeginClientRecovery(command);
                await CancelAndDisposeStartupAsync(startup, startupCancellation, "explicit-restart");
                return (null, "restart");
            }
            command.Completion.TrySetResult(Response(false, _state, "The application is starting; no surface is available to activate."));
        }
    }

    internal static async Task<(bool StartupCompleted, T? Command)> AwaitStartupOrCommandAsync<T>(
        Task startup,
        ChannelReader<T> commands,
        CancellationToken cancellationToken) where T : class
    {
        using var commandCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var commandWait = commands.ReadAsync(commandCancellation.Token).AsTask();
        var completed = await Task.WhenAny(startup, commandWait);
        if (completed == startup && !commandWait.IsCompleted)
        {
            commandCancellation.Cancel();
            try { await commandWait; } catch (OperationCanceledException) when (commandCancellation.IsCancellationRequested) { }
            return (true, null);
        }
        return (false, await commandWait);
    }

    internal static async Task CancelAndObserveStartupAsync(
        Task startup,
        CancellationTokenSource startupCancellation)
    {
        var canceledActiveStartup = !startup.IsCompleted;
        startupCancellation.Cancel();
        try
        {
            await startup;
        }
        catch (OperationCanceledException) when (canceledActiveStartup && startupCancellation.IsCancellationRequested)
        {
            // StartAsync normalizes cancellation-time startup and cleanup failures to
            // OCE. Already-completed or independently faulted startups still escape.
        }
    }

    private static async Task CancelAndDisposeStartupAsync(
        Task<ApplicationGeneration> startup,
        CancellationTokenSource startupCancellation,
        string reason)
    {
        var canceledActiveStartup = !startup.IsCompleted;
        startupCancellation.Cancel();
        try
        {
            var completedGeneration = await startup;
            await completedGeneration.StopAsync(reason);
            await completedGeneration.DisposeAsync();
        }
        catch (OperationCanceledException) when (canceledActiveStartup && startupCancellation.IsCancellationRequested)
        {
        }
        catch when (string.Equals(reason, "explicit-quit", StringComparison.Ordinal))
        {
            // Exact fenced quit remains terminal when the racing startup had
            // already failed; StartAsync owns partial-generation cleanup.
        }
    }

    private async Task<string> WaitForCommandOrFailureAsync(ApplicationGeneration generation, CancellationToken cancellationToken)
    {
        while (true)
        {
            var next = await AwaitFailureOrCommandAsync(generation.Failure, _commands.Reader, cancellationToken);
            if (next.FailureCompleted)
            {
                var failure = await generation.Failure;
                var recovery = InternalOperation();
                var failurePersisted = AppendAudit(recovery, "failure_detected", "restart", failure, generation.Id, "recovering", CurrentState(), 0);
                _log.Write($"generation={generation.Id} unexpected failure={failure}; rebuilding the complete generation");
                await StopAndDisposeGenerationAsync(generation, failure);
                var stoppedPersisted = AppendAudit(recovery, "generation_stopped", "restart", failure, generation.Id, "recovering", "stopped", ElapsedMilliseconds(recovery));
                _pendingTransition = new PendingTransition(recovery, null, generation.Id, failurePersisted && stoppedPersisted);
                return failure;
            }
            var command = next.Command!;
            switch (command.Command)
            {
                case "status":
                    command.Completion.TrySetResult(CurrentResponse(true));
                    break;
                case "activate":
                    if (TryGetPublishedManagerUrl(generation.Id, out var managerUrl))
                    {
                        TryOpenManager(managerUrl);
                        command.Completion.TrySetResult(CurrentResponse(true));
                    }
                    else
                    {
                        command.Completion.TrySetResult(Response(false, CurrentState(), "The active Manager endpoint has been revoked."));
                    }
                    break;
                case "source-patch":
                case "source-patch-reconcile":
                    if (!CanQuit(command) || command.SourcePatch is not { } sourcePatch || !SourcePatchTransport.Matches(generation.Ready, sourcePatch))
                    {
                        command.Completion.TrySetResult(Response(false, "stale_generation", "The source patch request does not match the active application and Manager."));
                        break;
                    }
                    if (Interlocked.Increment(ref _sourcePatchInFlight) > 4)
                    {
                        Interlocked.Decrement(ref _sourcePatchInFlight);
                        command.Completion.TrySetResult(Response(false, "busy", "Source patch forwarding is full; this request was not forwarded."));
                        break;
                    }
                    _ = ForwardSourcePatchCommandAsync(generation, command, sourcePatch, cancellationToken);
                    break;
                case "restart":
                    if (!CanQuit(command))
                    {
                        command.Completion.TrySetResult(Response(false, "stale_generation", "The restart request does not match the active application generation."));
                        break;
                    }
                    await StopAndDisposeGenerationAsync(generation, "explicit-restart");
                    _pendingTransition = new PendingTransition(command.Operation, command, command.ApplicationGenerationId, true);
                    return "restart";
                case "quit":
                    if (!CanQuit(command))
                    {
                        command.Completion.TrySetResult(Response(false, "stale_generation", "The quit request does not match the active application generation."));
                        break;
                    }
                    await CancelPendingTransitionAsync("fenced_quit_active_generation");
                    await StopAndDisposeGenerationAsync(generation, "explicit-quit");
                    PublishState("stopped");
                    command.Completion.TrySetResult(Response(true, _state));
                    await WaitForResponseSentAsync(command);
                    return "quit";
                default:
                    command.Completion.TrySetResult(Response(false, _state, "Unknown host command."));
                    break;
            }
        }
    }

    internal static async Task<(bool FailureCompleted, T? Command)> AwaitFailureOrCommandAsync<T>(
        Task failure,
        ChannelReader<T> commands,
        CancellationToken cancellationToken) where T : class
    {
        using var commandCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var commandWait = commands.ReadAsync(commandCancellation.Token).AsTask();
        var completed = await Task.WhenAny(failure, commandWait);
        if (completed == commandWait) return (false, await commandWait);
        commandCancellation.Cancel();
        try
        {
            // A channel item may have been committed concurrently with failure.
            // Preserve and process it instead of losing the request after ReadAsync.
            return (false, await commandWait);
        }
        catch (OperationCanceledException) when (commandCancellation.IsCancellationRequested)
        {
            return (true, null);
        }
    }

    private async Task ForwardSourcePatchCommandAsync(ApplicationGeneration generation, QueuedCommand command, JsonElement payload, CancellationToken cancellationToken)
    {
        try
        {
            var result = await generation.ForwardSourcePatchAsync(payload, command.Command == "source-patch-reconcile", cancellationToken);
            command.Completion.TrySetResult(result);
        }
        catch
        {
            command.Completion.TrySetResult(new HostResponse(false, "source_patch_unconfirmed", "Source patch forwarding did not confirm an outcome; query the original operation."));
        }
        finally { Interlocked.Decrement(ref _sourcePatchInFlight); }
    }

    private async Task<string?> WaitBackoffOrCommandAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + delay;
        while (true)
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) return null;
            using var commandCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var commandWait = _commands.Reader.ReadAsync(commandCancellation.Token).AsTask();
            var completed = await Task.WhenAny(Task.Delay(remaining, cancellationToken), commandWait);
            if (completed != commandWait)
            {
                commandCancellation.Cancel();
                try { await commandWait; } catch (OperationCanceledException) { }
                return null;
            }
            var command = await commandWait;
            if (command.Command == "quit")
            {
                if (!CanQuit(command))
                {
                    command.Completion.TrySetResult(Response(false, "stale_generation", "There is no matching active application generation."));
                    continue;
                }
                await CancelPendingTransitionAsync("fenced_quit_during_backoff");
                PublishState("stopped");
                command.Completion.TrySetResult(CurrentResponse(true));
                await WaitForResponseSentAsync(command);
                return "quit";
            }
            if (command.Command == "restart")
            {
                if (!CanQuit(command))
                {
                    command.Completion.TrySetResult(Response(false, "stale_generation", "There is no matching active application generation."));
                    continue;
                }
                BeginClientRecovery(command);
                return "restart";
            }
            if (command.Command == "status")
            {
                command.Completion.TrySetResult(CurrentResponse(true));
                continue;
            }
            command.Completion.TrySetResult(Response(false, _state, "The application is recovering; no surface is available to activate."));
        }
    }

    private async Task<string> WaitInFaultedStateAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            var command = await _commands.Reader.ReadAsync(cancellationToken);
            if (command.Command == "quit")
            {
                if (!CanQuit(command))
                {
                    command.Completion.TrySetResult(Response(false, "stale_generation", "There is no matching active application generation."));
                    continue;
                }
                await CancelPendingTransitionAsync("fenced_quit_faulted_host");
                PublishState("stopped");
                command.Completion.TrySetResult(Response(true, _state));
                await WaitForResponseSentAsync(command);
                return "quit";
            }
            if (command.Command == "restart")
            {
                if (!CanQuit(command))
                {
                    command.Completion.TrySetResult(Response(false, "stale_generation", "There is no matching active application generation."));
                    continue;
                }
                BeginClientRecovery(command);
                return "restart";
            }
            if (command.Command == "activate")
            {
                command.Completion.TrySetResult(Response(false, _state, "The application is faulted; query status and issue an exact generation-fenced restart."));
                continue;
            }
            if (command.Command == "status")
            {
                command.Completion.TrySetResult(Response(true, _state));
                continue;
            }
            command.Completion.TrySetResult(Response(false, _state, "Unknown host command."));
        }
    }

    private HostResponse Response(bool ok, string state, string? message = null)
    {
        var publication = _publication;
        return new(
            ok,
            state,
            message,
            publication.ApplicationGenerationId,
            publication.ControlFenceGenerationId,
            publication.ManagerInstanceId,
            publication.ManagerBaseUrl,
            publication.ManagerPid,
            publication.TrayPid,
            publication.TrayBoundManagerInstanceId,
            publication.JobMemberPids);
    }

    private HostResponse CurrentResponse(bool ok, string? message = null)
    {
        var publication = _publication;
        return new HostResponse(
            ok,
            publication.State,
            message,
            publication.ApplicationGenerationId,
            publication.ControlFenceGenerationId,
            publication.ManagerInstanceId,
            publication.ManagerBaseUrl,
            publication.ManagerPid,
            publication.TrayPid,
            publication.TrayBoundManagerInstanceId,
            publication.JobMemberPids);
    }

    private string CurrentState()
    {
        var publication = _publication;
        return publication.State;
    }

    private bool CanQuit(QueuedCommand command) => GenerationFence.AllowsQuit(
        _publication.ControlFenceGenerationId,
        command.ApplicationGenerationId);

    private void PublishState(string state)
    {
        lock (_publicationGate)
        {
            _state = state;
            RefreshPublicationLocked();
        }
    }

    private void RefreshPublication()
    {
        lock (_publicationGate) RefreshPublicationLocked();
    }

    private void RefreshPublicationLocked()
    {
        var active = string.Equals(_state, "healthy", StringComparison.Ordinal) ? _generation : null;
        _publication = active is null
            ? new LifecyclePublication(_state, _fenceGenerationId)
            : new LifecyclePublication(
                active.HealthState,
                _fenceGenerationId,
                active.Id,
                active.Ready.ManagerInstanceId,
                active.Ready.BaseUrl,
                active.Ready.Pid,
                active.TrayPid,
                active.TrayBoundManagerInstanceId,
                active.JobMemberPids.ToArray());
    }

    private bool AdoptGeneration(ApplicationGeneration generation)
    {
        lock (_publicationGate)
        {
            if (!CanAdoptGeneration(generation.Failure)) return false;
            _generation = generation;
            _fenceGenerationId = generation.Id;
            _state = "healthy";
            RefreshPublicationLocked();
            return true;
        }
    }

    private bool TryGetPublishedManagerUrl(string generationId, out string managerUrl)
    {
        lock (_publicationGate)
        {
            return TrySelectPublishedManagerUrl(_publication, generationId, out managerUrl);
        }
    }

    internal static bool CanAdoptGeneration(Task failure) => !failure.IsCompleted;

    internal static bool TrySelectPublishedManagerUrl(
        LifecyclePublication publication,
        string generationId,
        out string managerUrl)
    {
        if (string.Equals(publication.ApplicationGenerationId, generationId, StringComparison.Ordinal) &&
            publication.ManagerBaseUrl is not null &&
            (string.Equals(publication.State, "healthy", StringComparison.Ordinal) ||
             string.Equals(publication.State, "degraded", StringComparison.Ordinal)))
        {
            managerUrl = publication.ManagerBaseUrl;
            return true;
        }
        managerUrl = string.Empty;
        return false;
    }

    private void PublishGenerationHealth(string generationId, string healthState)
    {
        lock (_publicationGate)
        {
            if (!string.Equals(_publication.ApplicationGenerationId, generationId, StringComparison.Ordinal)) return;
            _publication = _publication with { State = healthState };
        }
    }

    private void PublishGenerationFailure(string generationId, string reason)
    {
        lock (_publicationGate)
        {
            if (!string.Equals(_fenceGenerationId, generationId, StringComparison.Ordinal)) return;
            _state = "stopping";
            _publication = new LifecyclePublication("stopping", _fenceGenerationId);
        }
        _log.Write($"generation={generationId} revoked published endpoint before failure completion reason={reason}");
    }

    private async Task StopAndDisposeGenerationAsync(ApplicationGeneration generation, string reason)
    {
        PublishState("stopping");
        lock (_publicationGate)
        {
            if (ReferenceEquals(_generation, generation)) _generation = null;
            RefreshPublicationLocked();
        }
        try { await generation.StopAsync(reason); }
        catch (Exception exception) { _log.Write($"generation={generation.Id} stop failed during teardown: {exception.Message}"); }
        try { await generation.DisposeAsync(); }
        catch (Exception exception) { _log.Write($"generation={generation.Id} dispose failed during teardown: {exception.Message}"); }
    }

    private async Task RunControlServerAsync(
        CancellationToken acceptCancellationToken,
        CancellationToken handlerCancellationToken)
    {
        const int maximumConcurrentConnections = 8;
        using var slots = new SemaphoreSlim(maximumConcurrentConnections, maximumConcurrentConnections);
        var handlers = new List<Task>();
        try
        {
            while (!acceptCancellationToken.IsCancellationRequested)
            {
                await slots.WaitAsync(acceptCancellationToken);
                System.IO.Pipes.NamedPipeServerStream? server = null;
                try
                {
                    server = HostProtocol.CreateServer();
                    await server.WaitForConnectionAsync(acceptCancellationToken);
                }
                catch (OperationCanceledException) when (acceptCancellationToken.IsCancellationRequested)
                {
                    if (server is not null) await server.DisposeAsync();
                    slots.Release();
                    throw;
                }
                catch (Exception exception)
                {
                    if (server is not null) await server.DisposeAsync();
                    slots.Release();
                    _log.Write($"Host control listener failed; rebuilding listener: {exception.Message}");
                    await Task.Delay(TimeSpan.FromMilliseconds(250), acceptCancellationToken);
                    continue;
                }
                await ObserveCompletedHandlersAsync(handlers);
                handlers.Add(HandleControlConnectionAsync(server, slots, handlerCancellationToken));
                server = null;
            }
        }
        finally
        {
            try { await Task.WhenAll(handlers); }
            catch (OperationCanceledException) when (handlerCancellationToken.IsCancellationRequested) { }
            catch (Exception exception) { _log.Write($"Host control handler failed during shutdown: {exception.Message}"); }
        }
    }

    private async Task HandleControlConnectionAsync(
        System.IO.Pipes.NamedPipeServerStream server,
        SemaphoreSlim slots,
        CancellationToken cancellationToken)
    {
        await using (server)
        {
            TaskCompletionSource<bool>? responseSent = null;
            QueuedCommand? queuedCommand = null;
            HostOperationContext? operation = null;
            string requestedCommand = "unreadable";
            string? requestedGenerationId = null;
            bool requestedAuditPersisted = false;
            bool requestedAuditAppended = false;
            bool terminalAuditAppended = false;
            try
            {
                var acceptedAt = DateTimeOffset.UtcNow;
                var peer = HostControlPeerInspector.CaptureConnection(server);
                operation = new HostOperationContext(
                    Guid.NewGuid().ToString("N"),
                    acceptedAt,
                    peer,
                    ResolveActorKind(peer));
                using var readCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                readCancellation.CancelAfter(TimeSpan.FromSeconds(5));
                var request = await HostProtocol.ReadAsync<HostRequest>(server, readCancellation.Token);
                requestedGenerationId = request.ApplicationGenerationId;
                requestedCommand = string.IsNullOrWhiteSpace(request.Command)
                    ? "empty"
                    : request.Command.Trim().ToLowerInvariant();
                if (!RequiresDurableAudit(requestedCommand))
                {
                    await HostProtocol.WriteAsync(server, CurrentResponse(true), cancellationToken);
                    return;
                }
                requestedAuditPersisted = AppendAudit(
                    operation,
                    "requested",
                    requestedCommand,
                    "request_received",
                    request.ApplicationGenerationId,
                    "received",
                    CurrentState(),
                    0);
                requestedAuditAppended = true;
                if (string.IsNullOrWhiteSpace(request.Command))
                {
                    var emptyResponse = CurrentResponse(false, "Host command must not be empty.");
                    await WriteAuditedResponseAsync(server, operation, requestedCommand, "invalid_operation", request.ApplicationGenerationId, emptyResponse, requestedAuditPersisted, () => terminalAuditAppended = true, cancellationToken);
                    return;
                }
                var normalizedCommand = requestedCommand;
                if (normalizedCommand != "status" && !IsAuthorizedMutationActor(operation.ActorKind))
                {
                    var denied = Response(false, "unauthorized", "The lifecycle mutation peer could not be proven as the packaged Host CLI.");
                    await WriteAuditedResponseAsync(server, operation, normalizedCommand, "peer_not_authorized", request.ApplicationGenerationId, denied, requestedAuditPersisted, () => terminalAuditAppended = true, cancellationToken);
                    return;
                }
                if (!AuditAllowsDispatch(normalizedCommand, requestedAuditPersisted))
                {
                    var denied = Response(false, "audit_unavailable", "The lifecycle mutation was rejected because its durable audit record could not be persisted.");
                    await WriteAuditedResponseAsync(server, operation, normalizedCommand, "audit_fail_closed", request.ApplicationGenerationId, denied, false, () => terminalAuditAppended = true, cancellationToken);
                    return;
                }
                var completion = new TaskCompletionSource<HostResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                responseSent = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                queuedCommand = new QueuedCommand(
                        normalizedCommand,
                        request.ApplicationGenerationId,
                        operation,
                        completion,
                        responseSent,
                        request.SourcePatch);
                var mutationAccepted = false;
                lock (_mutationAcceptanceGate)
                {
                    if (_acceptingMutations)
                    {
                        mutationAccepted = _acceptedMutations.TryAdd(operation.OperationId, queuedCommand);
                    }
                }
                if (!mutationAccepted)
                {
                    var stopped = Response(false, "stopped", "The Host is shutting down and no longer accepts lifecycle mutations.");
                    await WriteAuditedResponseAsync(server, operation, normalizedCommand, "host_shutdown", request.ApplicationGenerationId, stopped, requestedAuditPersisted, () => terminalAuditAppended = true, cancellationToken);
                    return;
                }
                try
                {
                    await _commands.Writer.WriteAsync(queuedCommand, cancellationToken);
                }
                catch
                {
                    _acceptedMutations.TryRemove(operation.OperationId, out _);
                    queuedCommand = null;
                    throw;
                }
                var response = await completion.Task.WaitAsync(cancellationToken);
                await WriteAuditedResponseAsync(
                    server,
                    operation,
                    normalizedCommand,
                    ReasonFor(normalizedCommand, request.ApplicationGenerationId, response),
                    request.ApplicationGenerationId,
                    response,
                    requestedAuditPersisted,
                    () => terminalAuditAppended = true,
                    cancellationToken);
            }
            catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
            {
                _log.Write($"host control request timed out: {exception.Message}");
                if (operation is not null && RequiresDurableAudit(requestedCommand) && !terminalAuditAppended)
                {
                    if (!requestedAuditAppended)
                    {
                        requestedAuditPersisted = AppendAudit(operation, "requested", requestedCommand, "request_unreadable", requestedGenerationId, "received", CurrentState(), 0);
                        requestedAuditAppended = true;
                    }
                    AppendTerminalAudit(operation, requestedCommand, "request_timeout", requestedGenerationId, "rejected", CurrentState());
                    terminalAuditAppended = true;
                }
            }
            catch (Exception exception)
            {
                _log.Write($"host control request failed: {exception.Message}");
                if (operation is not null && RequiresDurableAudit(requestedCommand) && !terminalAuditAppended)
                {
                    if (!requestedAuditAppended)
                    {
                        requestedAuditPersisted = AppendAudit(operation, "requested", requestedCommand, "request_unreadable", requestedGenerationId, "received", CurrentState(), 0);
                        requestedAuditAppended = true;
                    }
                    AppendTerminalAudit(operation, requestedCommand, "invalid_operation", requestedGenerationId, "rejected", CurrentState());
                    terminalAuditAppended = true;
                }
            }
            finally
            {
                responseSent?.TrySetResult(true);
                if (queuedCommand is not null)
                {
                    _acceptedMutations.TryRemove(queuedCommand.Operation.OperationId, out _);
                }
                slots.Release();
            }
        }
    }

    private async Task WriteAuditedResponseAsync(
        Stream server,
        HostOperationContext operation,
        string command,
        string reason,
        string? requestedGenerationId,
        HostResponse response,
        bool requestedAuditPersisted,
        Action markTerminalAuditAppended,
        CancellationToken cancellationToken)
    {
        var completedPersisted = AppendTerminalAudit(
            operation,
            command,
            reason,
            requestedGenerationId,
            response.Ok ? "completed" : "rejected",
            response.State);
        if (completedPersisted) markTerminalAuditAppended();
        await HostProtocol.WriteAsync(
            server,
            response with
            {
                OperationId = operation.OperationId,
                AuditPersisted = FinalAuditPersisted(requestedAuditPersisted, completedPersisted, response.AuditPersisted)
            },
            cancellationToken);
    }

    private bool AppendAudit(
        HostOperationContext operation,
        string phase,
        string command,
        string reason,
        string? requestedGenerationId,
        string result,
        string resultState,
        long durationMs)
    {
        var persisted = _audit.Append(new HostAuditEvent(
            1,
            DateTimeOffset.UtcNow,
            phase,
            operation.OperationId,
            operation.ActorKind,
            command,
            reason,
            requestedGenerationId,
            _publication.ApplicationGenerationId,
            result,
            resultState,
            durationMs,
            operation.Peer));
        if (!persisted)
        {
            _log.Write($"lifecycle audit persistence failed phase={phase} operationId={operation.OperationId}");
        }
        return persisted;
    }

    internal bool AppendTerminalAudit(
        HostOperationContext operation,
        string command,
        string reason,
        string? requestedGenerationId,
        string result,
        string resultState)
    {
        var marker = _terminalAuditOperations.GetValue(operation, static _ => new TerminalAuditMarker());
        lock (marker)
        {
            if (marker.Persisted) return true;
            marker.Event ??= new HostAuditEvent(
                1,
                DateTimeOffset.UtcNow,
                "completed",
                operation.OperationId,
                operation.ActorKind,
                command,
                reason,
                requestedGenerationId,
                _publication.ApplicationGenerationId,
                result,
                resultState,
                ElapsedMilliseconds(operation),
                operation.Peer);
            var persisted = _audit.Append(marker.Event);
            if (!persisted)
            {
                _log.Write($"lifecycle audit persistence failed phase=completed operationId={operation.OperationId}");
            }
            if (persisted) marker.Persisted = true;
            return persisted;
        }
    }

    private sealed class TerminalAuditMarker
    {
        internal HostAuditEvent? Event { get; set; }
        internal bool Persisted { get; set; }
    }

    internal static bool FinalAuditPersisted(bool requested, bool terminal, bool? upstream) =>
        requested && terminal && upstream != false;

    private string ReasonFor(
        string command,
        string? requestedGenerationId,
        HostResponse? response = null)
    {
        if (response?.State == "stale_generation") return "generation_mismatch";
        return command switch
        {
            "status" => "status_query",
            "activate" => "activate_surface",
            "restart" => "restart_request",
            "source-patch" => "source_patch_request",
            "source-patch-reconcile" => "source_patch_reconcile",
            "quit" when !string.IsNullOrWhiteSpace(requestedGenerationId) => "fenced_cli_exit",
            "quit" => "generation_mismatch",
            _ => "invalid_operation"
        };
    }

    private static long ElapsedMilliseconds(HostOperationContext operation) =>
        Math.Max(0, (long)(DateTimeOffset.UtcNow - operation.AcceptedAt).TotalMilliseconds);

    internal static bool AuditAllowsDispatch(string command, bool requestedAuditPersisted) =>
        string.Equals(command, "status", StringComparison.Ordinal) || requestedAuditPersisted;

    internal static bool RequiresDurableAudit(string command) =>
        !string.Equals(command, "status", StringComparison.Ordinal);

    private HostOperationContext InternalOperation() => new(
        Guid.NewGuid().ToString("N"),
        DateTimeOffset.UtcNow,
        new HostControlPeerSnapshot(null, null, null, Environment.ProcessPath, null, null, null, null, Array.Empty<string>()),
        "host-runtime");

    private void FailPendingTransition(string reason)
    {
        if (_pendingTransition is null) return;
        var transition = _pendingTransition;
        _pendingTransition = null;
        var failedPersisted = transition.ClientCommand is null
            ? AppendTerminalAudit(transition.Operation, "restart", reason, transition.RequestedGenerationId, "failed", _state)
            : AppendAudit(
                transition.Operation,
                "transition_failed",
                "restart",
                reason,
                transition.RequestedGenerationId,
                "failure_ready",
                _state,
                ElapsedMilliseconds(transition.Operation));
        transition.ClientCommand?.Completion.TrySetResult(
            Response(false, _state, "The replacement application generation could not become ready.") with
            {
                AuditPersisted = transition.AuditPersisted && failedPersisted
            });
    }

    private async Task CancelPendingTransitionAsync(string reason)
    {
        if (_pendingTransition is null) return;
        var transition = _pendingTransition;
        _pendingTransition = null;
        var cancelledPersisted = transition.ClientCommand is null
            ? AppendTerminalAudit(transition.Operation, "restart", reason, transition.RequestedGenerationId, "cancelled", _state)
            : AppendAudit(
                transition.Operation,
                "transition_cancelled",
                "restart",
                reason,
                transition.RequestedGenerationId,
                "cancellation_ready",
                _state,
                ElapsedMilliseconds(transition.Operation));
        transition.ClientCommand?.Completion.TrySetResult(
            Response(false, "cancelled", "The recovery operation was cancelled by an exact generation-fenced quit.") with
            {
                AuditPersisted = transition.AuditPersisted && cancelledPersisted
            });
        if (transition.ClientCommand is not null)
        {
            await WaitForResponseSentAsync(transition.ClientCommand);
        }
    }

    private async Task CompletePendingForHostShutdownAsync(string reason)
    {
        if (_pendingTransition is null) return;
        var transition = _pendingTransition;
        _pendingTransition = null;
        if (transition.ClientCommand is null)
        {
            AppendTerminalAudit(
                transition.Operation,
                "restart",
                reason,
                transition.RequestedGenerationId,
                "cancelled",
                "stopped");
            return;
        }
        var cancelledPersisted = AppendAudit(
            transition.Operation,
            "transition_cancelled",
            "restart",
            reason,
            transition.RequestedGenerationId,
            "cancellation_ready",
            "stopped",
            ElapsedMilliseconds(transition.Operation));
        transition.ClientCommand.Completion.TrySetResult(
            Response(false, "stopped", "The Host stopped before the replacement application generation became ready.") with
            {
                AuditPersisted = transition.AuditPersisted && cancelledPersisted
            });
        await WaitForResponseSentAsync(transition.ClientCommand);
    }

    private async Task CompleteAcceptedMutationsForHostShutdownAsync(string reason)
    {
        while (true)
        {
            var accepted = _acceptedMutations.Values.ToArray();
            if (accepted.Length == 0) return;
            foreach (var command in accepted)
            {
                if (!command.Completion.Task.IsCompleted)
                {
                    command.Completion.TrySetResult(
                        Response(false, "stopped", "The Host stopped before the lifecycle mutation completed."));
                }
            }
            await Task.WhenAll(accepted.Select(command => command.ResponseSent.Task));
            foreach (var command in accepted)
            {
                _acceptedMutations.TryRemove(command.Operation.OperationId, out _);
            }
        }
    }

    private void BeginInternalRecovery(string reason)
    {
        var operation = InternalOperation();
        var persisted = AppendAudit(operation, "recovery_requested", "restart", reason, _fenceGenerationId, "recovering", _state, 0);
        _pendingTransition = new PendingTransition(operation, null, _fenceGenerationId, persisted);
    }

    private async Task ObserveCompletedHandlersAsync(List<Task> handlers)
    {
        for (var index = handlers.Count - 1; index >= 0; index--)
        {
            var handler = handlers[index];
            if (!handler.IsCompleted) continue;
            handlers.RemoveAt(index);
            try { await handler; }
            catch (OperationCanceledException) { }
            catch (Exception exception) { _log.Write($"Host control handler failed: {exception.Message}"); }
        }
    }

    private void BeginClientRecovery(QueuedCommand command)
    {
        if (_pendingTransition is not null)
        {
            var previous = _pendingTransition;
            var supersededPersisted = previous.ClientCommand is null
                ? AppendTerminalAudit(previous.Operation, "restart", "explicit_fenced_restart", previous.RequestedGenerationId, "superseded", _state)
                : AppendAudit(
                    previous.Operation,
                    "transition_superseded",
                    "restart",
                    "explicit_fenced_restart",
                    previous.RequestedGenerationId,
                    "supersession_ready",
                    _state,
                    ElapsedMilliseconds(previous.Operation));
            previous.ClientCommand?.Completion.TrySetResult(
                Response(false, "superseded", "A newer exact generation-fenced restart superseded this recovery operation.") with
                {
                    AuditPersisted = previous.AuditPersisted && supersededPersisted
                });
        }
        var requestedPersisted = AppendAudit(command.Operation, "recovery_requested", "restart", "fenced_restart", command.ApplicationGenerationId, "recovering", _state, ElapsedMilliseconds(command.Operation));
        _pendingTransition = new PendingTransition(command.Operation, command, command.ApplicationGenerationId, requestedPersisted);
    }

    private string ResolveActorKind(HostControlPeerSnapshot peer)
    {
        if (HostControlPeerInspector.ActorKind(peer) != "host-cli") return "unresolved";
        var publication = _publication;
        if (publication.TrayPid is not null && peer.ParentPid == publication.TrayPid)
        {
            var expectedTray = Path.GetFullPath(Path.Combine(_packageRoot, "desktop-runtime", "python", "pythonw.exe"));
            if (!string.IsNullOrWhiteSpace(peer.ParentImagePath) &&
                string.Equals(Path.GetFullPath(peer.ParentImagePath), expectedTray, StringComparison.OrdinalIgnoreCase))
            {
                return "tray-via-host-cli";
            }
        }
        var parentName = string.IsNullOrWhiteSpace(peer.ParentImagePath)
            ? string.Empty
            : Path.GetFileName(peer.ParentImagePath);
        if (parentName.Contains("setup", StringComparison.OrdinalIgnoreCase) ||
            parentName.StartsWith("unins", StringComparison.OrdinalIgnoreCase))
        {
            return "installer-observed-parent-via-host-cli";
        }
        return "interactive-host-cli";
    }

    private static bool IsAuthorizedMutationActor(string actorKind) =>
        actorKind is "tray-via-host-cli" or "installer-observed-parent-via-host-cli" or "interactive-host-cli";

    private static async Task WaitForResponseSentAsync(QueuedCommand command)
    {
        await command.ResponseSent.Task;
    }

    private static void TryOpenManager(string baseUrl)
    {
        try { Process.Start(new ProcessStartInfo(baseUrl) { UseShellExecute = true }); }
        catch { }
    }
}
