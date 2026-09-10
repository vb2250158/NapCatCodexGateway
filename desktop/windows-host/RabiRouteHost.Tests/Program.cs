using RabiRoute.WindowsHost;
using System.Net;
using System.Net.Sockets;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

var failures = new List<string>();

void Check(bool condition, string message)
{
    if (!condition) failures.Add(message);
}

await SourcePatchTests.RunAsync(Check);

Check(NativeChildProcess.QuoteWindowsArgument("plain") == "plain", "plain argument quoting");
Check(NativeChildProcess.QuoteWindowsArgument("two words") == "\"two words\"", "space argument quoting");
Check(NativeChildProcess.QuoteWindowsArgument("C:\\trailing slash\\") == "\"C:\\trailing slash\\\\\"", "trailing slash quoting");

const string generation = "generation-a";
const uint managerPid = 4242;
var readyLine = ManagerReadiness.Prefix +
    "{\"protocolVersion\":1,\"applicationGenerationId\":\"generation-a\",\"managerInstanceId\":\"manager-a\",\"pid\":4242," +
    "\"baseUrl\":\"http://127.0.0.1:54321\",\"readyAt\":\"2026-08-30T10:00:00Z\"}";
var ready = ManagerReadiness.Parse(readyLine, generation, managerPid);
Check(ready?.BaseUrl == "http://127.0.0.1:54321", "valid structured readiness");
Check(ManagerReadiness.Parse(readyLine, "wrong-generation", managerPid) is null, "reject stale generation readiness");
Check(ManagerReadiness.Parse(readyLine, generation, 7) is null, "reject readiness from a different pid");
Check(ManagerReadiness.Parse(readyLine.Replace("\"protocolVersion\":1", "\"protocolVersion\":2"), generation, managerPid) is null, "reject unsupported readiness protocol");
Check(ManagerReadiness.Parse(readyLine.Replace("127.0.0.1", "example.com"), generation, managerPid) is null, "reject non-loopback endpoint");
Check(ManagerReadiness.Parse("noise " + readyLine, generation, managerPid) is null, "reject unframed readiness");
Check(GenerationFence.AllowsQuit(generation, generation), "accept matching application generation quit");
Check(!GenerationFence.AllowsQuit(generation, "stale-generation"), "reject stale application generation quit");
Check(!GenerationFence.AllowsQuit(null, generation), "reject fenced quit without an active generation");
Check(!GenerationFence.AllowsQuit(generation, null), "reject every unfenced quit");
const string faultedControlFence = "faulted-control-fence";
Check(
    GenerationFence.AllowsQuit(faultedControlFence, faultedControlFence),
    "faulted Host accepts an exact retained control fence for terminal quit");
Check(
    !GenerationFence.AllowsQuit(faultedControlFence, "stale-faulted-control-fence"),
    "faulted Host rejects a stale retained control fence");
var trayArguments = ApplicationGeneration.BuildTrayArguments(
    "C:\\immutable\\desktop-runtime\\main.py",
    ready!,
    generation,
    "C:\\stable\\RabiRouteHost.exe",
    "RabiRoute.Tray.test");
Check(trayArguments[0] == "-B", "Tray disables Python bytecode before loading immutable package code");
Check(trayArguments[1] == "C:\\immutable\\desktop-runtime\\main.py", "Tray script remains inside the immutable package");
var trayEnvironment = ApplicationGeneration.BuildTrayEnvironment("C:\\immutable", "C:\\state", generation);
Check(trayEnvironment["PYTHONDONTWRITEBYTECODE"] == "1", "Tray environment prevents __pycache__ writes into the immutable package");
Check(trayEnvironment["RABIROUTE_STATE_ROOT"] == "C:\\state", "Tray mutable state remains fenced to the state root");
Check(HostRuntime.AuditAllowsDispatch("status", false), "status remains read-only when audit storage is unavailable");
Check(!HostRuntime.RequiresDurableAudit("status"), "status bypasses durable lifecycle audit and returns the current Host snapshot");
Check(HostRuntime.RequiresDurableAudit("restart"), "restart keeps durable lifecycle audit before dispatch");
Check(!HostRuntime.AuditAllowsDispatch("quit", false), "quit fails closed before dispatch when audit storage is unavailable");
Check(!HostRuntime.AuditAllowsDispatch("restart", false), "restart fails closed before dispatch when audit storage is unavailable");
Check(!HostRuntime.AuditAllowsDispatch("activate", false), "activate fails closed before dispatch when audit storage is unavailable");
Check(ApplicationGeneration.ManagerReadyTimeout >= TimeSpan.FromMinutes(3), "Manager cold startup tolerates temporary machine pressure without a restart storm");
Check(ApplicationGeneration.TrayReadyTimeout >= TimeSpan.FromMinutes(2), "Tray cold startup tolerates temporary machine pressure without restarting a healthy Manager");
Check(HostRuntime.AuditAllowsDispatch("quit", true), "durably audited fenced quit may enter the lifecycle queue");
Check(
    HostIdentity.UserKey("S-1-5-21-test") == HostIdentity.UserKey("S-1-5-21-test"),
    "Host identity namespace is stable for the same SID source");
Check(
    HostIdentity.UserKey("S-1-5-21-test") != HostIdentity.UserKey("S-1-5-21-other"),
    "Host identity namespace does not collapse different SID sources");

var stableNodeRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-stable-node-{Guid.NewGuid():N}");
var stableNodeState = Path.Combine(stableNodeRoot, "install");
var stableNodePackageA = Path.Combine(stableNodeRoot, "versions", "release-a");
var stableNodePackageB = Path.Combine(stableNodeRoot, "versions", "release-b");
Directory.CreateDirectory(stableNodePackageA);
Directory.CreateDirectory(stableNodePackageB);
Directory.CreateDirectory(stableNodeState);
try
{
    File.WriteAllText(Path.Combine(stableNodePackageA, "node.exe"), "node-runtime-a");
    File.WriteAllText(Path.Combine(stableNodePackageB, "node.exe"), "node-runtime-b");
    var stableNodeA = StableNodeRuntime.Resolve(stableNodePackageA, stableNodeState);
    Check(
        stableNodeA == Path.Combine(stableNodeState, StableNodeRuntime.RuntimeDirectoryName, StableNodeRuntime.RuntimeFileName),
        "Node.js executes from one stable install-root path instead of a release directory");
    Check(File.ReadAllText(stableNodeA) == "node-runtime-a", "stable Node.js runtime copies the validated release runtime");
    var stableNodeB = StableNodeRuntime.Resolve(stableNodePackageB, stableNodeState);
    Check(stableNodeB == stableNodeA, "Node.js executable path remains stable across release changes");
    Check(File.ReadAllText(stableNodeB) == "node-runtime-b", "stable Node.js runtime updates when the validated runtime changes");
    File.WriteAllText(stableNodeB, "tampered-runtime");
    StableNodeRuntime.Resolve(stableNodePackageB, stableNodeState);
    Check(File.ReadAllText(stableNodeB) == "node-runtime-b", "stable Node.js runtime repairs a mismatched mutable copy");
}
finally
{
    Directory.Delete(stableNodeRoot, recursive: true);
}

var portPreferenceRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-port-preference-{Guid.NewGuid():N}");
Directory.CreateDirectory(portPreferenceRoot);
try
{
    await using var portPreferenceLog = new HostLog(Path.Combine(portPreferenceRoot, "diagnostics"));
    Check(
        ManagerPortPreference.ResolveStartupPolicy(portPreferenceRoot, portPreferenceLog) == "auto",
        "Host uses OS allocation before a successful Manager endpoint has been cached");
    ManagerPortPreference.SaveSuccessfulEndpoint(portPreferenceRoot, "http://127.0.0.1:54321", portPreferenceLog);
    Check(
        ManagerPortPreference.ResolveStartupPolicy(portPreferenceRoot, portPreferenceLog) == "prefer:54321",
        "Host supplies the last successful Manager port as a preference to the next generation");
    var preferenceFile = Path.Combine(portPreferenceRoot, "host", "manager-port-preference.json");
    var preferenceJson = File.ReadAllText(preferenceFile);
    Check(preferenceJson.Contains("54321", StringComparison.Ordinal), "Host persists the successful Manager port");
    Check(
        !preferenceJson.Contains("baseUrl", StringComparison.OrdinalIgnoreCase) &&
        !preferenceJson.Contains("generation", StringComparison.OrdinalIgnoreCase),
        "Host port preference never persists an endpoint URL or generation identity");
}
finally
{
    Directory.Delete(portPreferenceRoot, recursive: true);
}

var portableRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-portable-guard-{Guid.NewGuid():N}");
var portablePackageRoot = Path.Combine(portableRoot, "versions", "release-a");
var portableStateRoot = portableRoot;
Directory.CreateDirectory(Path.Combine(portablePackageRoot, "scripts"));
Directory.CreateDirectory(Path.Combine(portableStateRoot, "scripts"));
try
{
    Check(
        PortableOverlayGuard.FindRetiredLifecycleEntriesForStartup(portablePackageRoot, portableStateRoot).Count == 0,
        "clean portable root is accepted");
    File.WriteAllText(Path.Combine(portableStateRoot, "scripts", "watch-rabiroute-health.ps1.backup"), "fixture");
    Check(
        PortableOverlayGuard.FindRetiredLifecycleEntriesForStartup(portablePackageRoot, portableStateRoot).Count == 0,
        "similarly named backup cannot trigger the portable overlay guard");
    File.WriteAllText(Path.Combine(portablePackageRoot, "RabiRoute-Tray.exe"), "fixture");
    Check(
        PortableOverlayGuard.FindRetiredLifecycleEntriesForStartup(portablePackageRoot, portableStateRoot)
            .SequenceEqual(new[] { "RabiRoute-Tray.exe" }),
        "portable overlay guard preserves and inspects the active package root");
    File.Delete(Path.Combine(portablePackageRoot, "RabiRoute-Tray.exe"));
    File.WriteAllText(Path.Combine(portableStateRoot, "RabiRoute-Desktop.exe"), "fixture");
    File.WriteAllText(Path.Combine(portableStateRoot, "scripts", "watch-rabiroute-health.ps1"), "fixture");
    var retiredEntries = PortableOverlayGuard.FindRetiredLifecycleEntriesForStartup(portablePackageRoot, portableStateRoot);
    Check(
        retiredEntries.SequenceEqual(new[] { "RabiRoute-Desktop.exe", "scripts/watch-rabiroute-health.ps1" }),
        "portable overlay guard reports only exact retired lifecycle entries");
    var blockedMessage = PortableOverlayGuard.BlockedMessage(retiredEntries);
    Check(blockedMessage.Contains("new empty folder", StringComparison.Ordinal),
        "portable overlay failure directs the user to a clean folder");
    Check(blockedMessage.Contains("Windows Setup", StringComparison.Ordinal),
        "portable overlay failure directs the user to the migration owner");
}
finally
{
    Directory.Delete(portableRoot, true);
}

var peerPipeName = $"RabiRoute.Host.Tests.{Guid.NewGuid():N}";
var peerServerTask = Task.Run(async () =>
{
    await using var server = HostProtocol.CreateServer(peerPipeName);
    await server.WaitForConnectionAsync();
    var connection = HostControlPeerInspector.CaptureConnection(server);
    await HostProtocol.ReadAsync<HostRequest>(server, CancellationToken.None);
    return connection;
});
await using (var peerClient = new NamedPipeClientStream(
                 ".",
                 peerPipeName,
                 PipeDirection.InOut,
                 PipeOptions.Asynchronous,
                 TokenImpersonationLevel.Identification))
{
    await peerClient.ConnectAsync(CancellationToken.None);
    await HostProtocol.WriteAsync(peerClient, new HostRequest("status"), CancellationToken.None);
    var peer = await peerServerTask.WaitAsync(TimeSpan.FromSeconds(5));
    Check(peer.ClientPid == (uint)Environment.ProcessId, "named-pipe peer PID is derived from the kernel connection");
    Check(peer.ClientSidHash == HostIdentity.CurrentUserKey(), "named-pipe peer SID is captured through impersonation and hashed");
    Check(!string.IsNullOrWhiteSpace(peer.ClientImagePath), "named-pipe peer image is resolved from the kernel PID");
    Check(peer.ClientStartedAt is not null, "named-pipe peer creation time fences PID reuse");
    Check(HostControlPeerInspector.ActorKind(peer) == "host-cli", "same-SID client with the exact server image is classified as Host CLI");
}

var auditRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-host-audit-{Guid.NewGuid():N}");
var auditPeer = new HostControlPeerSnapshot(
    (uint)Environment.ProcessId,
    DateTimeOffset.UtcNow,
    HostIdentity.CurrentUserKey(),
    Environment.ProcessPath,
    null,
    null,
    null,
    null,
    Array.Empty<string>());
var auditContext = new HostOperationContext(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow, auditPeer, "host-cli");
Check(
    HostControlPeerInspector.ActorKind(auditPeer with { ClientImagePath = Path.Combine(Path.GetTempPath(), "not-rabiroute-host.exe") }) == "same-user-unknown",
    "same-user peer with a different image cannot mutate Host lifecycle");
var audit = new HostLifecycleAudit(auditRoot);
Check(
    audit.Append(new HostAuditEvent(
        1, DateTimeOffset.UtcNow, "requested", auditContext.OperationId, auditContext.ActorKind,
        "quit", "fenced_cli_exit", generation, generation, "accepted", "healthy", 0, auditPeer)),
    "append-only lifecycle audit persists a control request");
Check(
    audit.Append(new HostAuditEvent(
        1, DateTimeOffset.UtcNow, "completed", auditContext.OperationId, auditContext.ActorKind,
        "quit", "fenced_cli_exit", generation, generation, "completed", "stopped", 12, auditPeer)),
    "append-only lifecycle audit persists a control result");
Check(
    audit.Append(new HostAuditEvent(
        1, DateTimeOffset.UtcNow, "completed", auditContext.OperationId, auditContext.ActorKind,
        "quit", "fenced_cli_exit", generation, generation, "completed", "stopped", 13, auditPeer)),
    "terminal lifecycle audit retry resolves to the existing durable receipt");
var auditLines = File.ReadAllLines(Directory.GetFiles(auditRoot, "lifecycle-audit-*.jsonl").Single());
Check(auditLines.Length == 2, "one lifecycle operation has exactly requested and completed audit records");
foreach (var auditLine in auditLines)
{
    using var auditJson = JsonDocument.Parse(auditLine);
    Check(auditJson.RootElement.GetProperty("operationId").GetString() == auditContext.OperationId,
        "lifecycle audit preserves one server operation id across both phases");
    Check(!auditLine.Contains("S-1-", StringComparison.OrdinalIgnoreCase),
        "lifecycle audit never persists a raw SID");
}
Check(
    auditLines.Select(line => JsonDocument.Parse(line).RootElement.GetProperty("phase").GetString()).ToHashSet()
        .SetEquals(new[] { "requested", "completed" }),
    "lifecycle audit contains one requested and one completed phase");
Check(
    !new HostLifecycleAudit("invalid\0audit-root").Append(new HostAuditEvent(
        1, DateTimeOffset.UtcNow, "completed", auditContext.OperationId, auditContext.ActorKind,
        "quit", "fenced_cli_exit", generation, generation, "completed", "stopped", 1, auditPeer)),
    "audit persistence failure is observable so lifecycle mutations can fail closed");

var terminalSequenceAudit = new SequenceLifecycleAudit(false, true);
await using (var terminalLog = new HostLog(Path.Combine(Path.GetTempPath(), $"rabiroute-terminal-log-{Guid.NewGuid():N}")))
{
    var terminalRuntime = new HostRuntime("package", "state", terminalLog, terminalSequenceAudit);
    var firstTerminal = terminalRuntime.AppendTerminalAudit(
        auditContext, "restart", "host_shutdown", generation, "cancelled", "stopped");
    var retriedTerminal = terminalRuntime.AppendTerminalAudit(
        auditContext, "restart", "different_retry_reason", generation, "rejected", "faulted");
    Check(!firstTerminal && retriedTerminal, "terminal audit can recover after one storage failure");
    Check(
        terminalSequenceAudit.Entries.Count == 2 &&
        ReferenceEquals(terminalSequenceAudit.Entries[0], terminalSequenceAudit.Entries[1]) &&
        terminalSequenceAudit.Entries[1].Reason == "host_shutdown" &&
        terminalSequenceAudit.Entries[1].Result == "cancelled" &&
        terminalSequenceAudit.Entries[1].ResultState == "stopped",
        "terminal audit retry preserves the first canonical event object and semantics");
}
Check(HostRuntime.FinalAuditPersisted(true, true, null), "handler reports a recovered canonical terminal with no failed upstream phase");
Check(!HostRuntime.FinalAuditPersisted(true, true, false), "handler preserves an upstream audit-chain failure");
Check(!HostRuntime.FinalAuditPersisted(true, false, null), "handler never reports an unpersisted terminal audit");

var recoveryAuditRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-audit-recovery-{Guid.NewGuid():N}");
Directory.CreateDirectory(recoveryAuditRoot);
try
{
    var recoveryTimestamp = DateTimeOffset.UtcNow;
    var recoveryPath = Path.Combine(recoveryAuditRoot, $"lifecycle-audit-{recoveryTimestamp:yyyyMMdd}.jsonl");
    var unrelated = new HostAuditEvent(
        1, recoveryTimestamp, "completed", "unrelated-operation", "host-cli",
        "status", "status_query", null, generation, "completed", "healthy", 1, auditPeer);
    var recoveredTarget = new HostAuditEvent(
        1, recoveryTimestamp, "completed", "recovered-operation", "host-cli",
        "quit", "fenced_cli_exit", generation, generation, "completed", "stopped", 2, auditPeer);
    var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    File.WriteAllLines(recoveryPath, new[]
    {
        JsonSerializer.Serialize(unrelated, jsonOptions),
        JsonSerializer.Serialize(recoveredTarget, jsonOptions)
    });
    var readAttempts = 0;
    IEnumerable<string> RecoveringReader(string path)
    {
        readAttempts++;
        var lines = File.ReadLines(path).ToArray();
        yield return lines[0];
        if (readAttempts == 1) throw new IOException("injected index recovery interruption");
        for (var index = 1; index < lines.Length; index++) yield return lines[index];
    }
    var recoveryAudit = new HostLifecycleAudit(recoveryAuditRoot, RecoveringReader);
    Check(recoveryAudit.Append(recoveredTarget), "terminal index recovery retries after an interrupted initial scan");
    Check(readAttempts == 2, "terminal index recovery performs a complete second scan");
    Check(File.ReadAllLines(recoveryPath).Length == 2, "interrupted index recovery never appends a duplicate terminal record");
}
finally
{
    Directory.Delete(recoveryAuditRoot, true);
}

using (var healthyMeta = JsonDocument.Parse(
           "{\"applicationGenerationId\":\"generation-a\",\"managerInstanceId\":\"manager-a\"," +
           "\"managerBaseUrl\":\"http://127.0.0.1:54321\",\"health\":{\"state\":\"healthy\",\"pid\":4242,\"live\":true,\"requiredReady\":true}}"))
{
    Check(
        ManagerLifecycleClient.ValidateHealth(healthyMeta.RootElement, ready!, generation).State == ManagerProbeState.Healthy,
        "accept exact generation Manager health identity");
}
using (var degradedMeta = JsonDocument.Parse(
           "{\"applicationGenerationId\":\"generation-a\",\"managerInstanceId\":\"manager-a\"," +
           "\"managerBaseUrl\":\"http://127.0.0.1:54321/\",\"health\":{\"state\":\"degraded\",\"pid\":4242,\"live\":true,\"requiredReady\":true}}"))
{
    Check(
        ManagerLifecycleClient.ValidateHealth(degradedMeta.RootElement, ready!, generation).State == ManagerProbeState.Degraded,
        "optional plugin degradation remains a live required-ready generation");
}
using (var requiredCapabilityFailure = JsonDocument.Parse(
           "{\"applicationGenerationId\":\"generation-a\",\"managerInstanceId\":\"manager-a\"," +
           "\"managerBaseUrl\":\"http://127.0.0.1:54321/\",\"health\":{\"state\":\"degraded\",\"pid\":4242,\"live\":true,\"requiredReady\":false}}"))
{
    Check(
        ManagerLifecycleClient.ValidateHealth(requiredCapabilityFailure.RootElement, ready!, generation).State == ManagerProbeState.Failed,
        "required capability loss is not retained as an indefinitely healthy generation");
}
using (var staleMeta = JsonDocument.Parse(
           "{\"applicationGenerationId\":\"generation-b\",\"managerInstanceId\":\"manager-a\"," +
           "\"managerBaseUrl\":\"http://127.0.0.1:54321\",\"health\":{\"state\":\"healthy\",\"pid\":4242,\"live\":true,\"requiredReady\":true}}"))
{
    Check(
        ManagerLifecycleClient.ValidateHealth(staleMeta.RootElement, ready!, generation).State == ManagerProbeState.Failed,
        "reject stale Manager generation health identity");
}

var restartWindow = new RestartFailureWindow(5, TimeSpan.FromMinutes(2));
var failureStart = DateTimeOffset.Parse("2026-08-30T10:00:00Z");
for (var index = 0; index < 4; index++) restartWindow.Record(failureStart.AddSeconds(index));
Check(!restartWindow.IsOpen(failureStart.AddSeconds(4)), "restart circuit remains closed below the bounded threshold");
restartWindow.Record(failureStart.AddSeconds(5));
Check(restartWindow.IsOpen(failureStart.AddSeconds(5)), "restart circuit opens for a failure storm");
Check(!restartWindow.IsOpen(failureStart.AddMinutes(3)), "restart circuit ages out unrelated historical failures");
var slowRestartWindow = new RestartFailureWindow(5, RestartFailureWindow.DefaultWindow);
for (var index = 0; index < 5; index++) slowRestartWindow.Record(failureStart.AddSeconds(index * 90));
Check(slowRestartWindow.IsOpen(failureStart.AddMinutes(6)), "restart circuit also bounds minute-long startup failure loops");
Check(!slowRestartWindow.IsOpen(failureStart.AddMinutes(22)), "slow failure history expires after a stable interval");

await using (var unavailableLog = new HostLog("invalid\0host-log-root"))
{
    for (var index = 0; index < 2048; index++) unavailableLog.Write($"isolated diagnostic {index}");
}
Check(true, "logging failures and a saturated bounded queue do not escape into Host lifecycle code");

using (var startupCancellation = new CancellationTokenSource())
{
    var canceledCleanupFault = Task.Delay(Timeout.InfiniteTimeSpan, startupCancellation.Token);
    await HostRuntime.CancelAndObserveStartupAsync(canceledCleanupFault, startupCancellation);
    Check(startupCancellation.IsCancellationRequested, "command cancellation absorbs cleanup failures from the active startup");
}
var preexistingStartupFailureObserved = false;
using (var startupCancellation = new CancellationTokenSource())
{
    try
    {
        await HostRuntime.CancelAndObserveStartupAsync(
            Task.FromException(new InvalidOperationException("preexisting startup failure")),
            startupCancellation);
    }
    catch (InvalidOperationException)
    {
        preexistingStartupFailureObserved = true;
    }
}
Check(preexistingStartupFailureObserved, "command cancellation does not hide an already-completed startup failure");
Check(!HostRuntime.CanAdoptGeneration(Task.CompletedTask), "a generation whose failure already completed cannot be adopted");
Check(HostRuntime.CanAdoptGeneration(new TaskCompletionSource().Task), "a live generation remains eligible for atomic admission");
var healthyPublication = new LifecyclePublication(
    "healthy", generation, generation, "manager-a", "http://127.0.0.1:54321");
Check(
    HostRuntime.TrySelectPublishedManagerUrl(healthyPublication, generation, out var publishedManagerUrl) &&
    publishedManagerUrl == "http://127.0.0.1:54321",
    "activate selects only the currently published healthy Manager endpoint");
Check(
    !HostRuntime.TrySelectPublishedManagerUrl(healthyPublication with { State = "stopping" }, generation, out _),
    "activate rejects a revoked Manager endpoint");
Check(
    !HostRuntime.TrySelectPublishedManagerUrl(healthyPublication, "stale-generation", out _),
    "activate rejects a Manager endpoint from another application generation");

await using (var trayLifecycle = new TrayLifecycleChannel("test-generation"))
await using (var trayClient = new NamedPipeClientStream(
                 ".",
                 trayLifecycle.PipeName,
                 PipeDirection.InOut,
                 PipeOptions.Asynchronous))
{
    await trayClient.ConnectAsync(CancellationToken.None);
    await using var writer = new StreamWriter(trayClient, Encoding.UTF8, leaveOpen: true) { AutoFlush = true };
    await writer.WriteLineAsync(
        "RABIROUTE_TRAY_READY:{\"protocolVersion\":1,\"applicationGenerationId\":\"test-generation\"," +
        "\"managerInstanceId\":\"manager-a\",\"pid\":4243}");
    var trayReady = await trayLifecycle.WaitForReadyAsync(
        "test-generation", "manager-a", 4243, TimeSpan.FromSeconds(2), CancellationToken.None);
    Check(
        trayReady?.ManagerInstanceId == "manager-a" && trayReady.Pid == 4243,
        "Host accepts exact Tray generation readiness");
    var shutdown = trayLifecycle.RequestShutdownAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
    using var reader = new StreamReader(trayClient, Encoding.UTF8, false, leaveOpen: true);
    var command = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(2));
    Check(await shutdown, "Host sends the graceful Tray lifecycle command over the private pipe");
    Check(command == "shutdown", "Tray lifecycle pipe carries the shutdown command");
}

await using (var staleTrayLifecycle = new TrayLifecycleChannel("test-generation"))
await using (var staleTrayClient = new NamedPipeClientStream(
                 ".",
                 staleTrayLifecycle.PipeName,
                 PipeDirection.InOut,
                 PipeOptions.Asynchronous))
{
    await staleTrayClient.ConnectAsync(CancellationToken.None);
    await using var writer = new StreamWriter(staleTrayClient, Encoding.UTF8, leaveOpen: true) { AutoFlush = true };
    await writer.WriteLineAsync(
        "RABIROUTE_TRAY_READY:{\"protocolVersion\":1,\"applicationGenerationId\":\"stale-generation\"," +
        "\"managerInstanceId\":\"manager-a\",\"pid\":4243}");
    Check(
        await staleTrayLifecycle.WaitForReadyAsync(
            "test-generation", "manager-a", 4243, TimeSpan.FromSeconds(2), CancellationToken.None) is null,
        "Host rejects stale Tray generation readiness");
}

var lifecycleListener = new TcpListener(IPAddress.Loopback, 0);
lifecycleListener.Start();
var lifecyclePort = ((IPEndPoint)lifecycleListener.LocalEndpoint).Port;
var lifecycleReady = new ManagerReady(
    1,
    generation,
    "manager-a",
    managerPid,
    $"http://127.0.0.1:{lifecyclePort}",
    "2026-08-30T10:00:00Z");
string? lifecycleHealthRequest = null;
string? lifecycleShutdownRequest = null;
var observedLifecyclePaths = new List<string>();
using var lifecycleServerCancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
string LifecycleObservationSummary()
{
    var observed = observedLifecyclePaths.Count == 0
        ? "<none>"
        : string.Join(", ", observedLifecyclePaths);
    var missing = new List<string>();
    if (lifecycleHealthRequest is null) missing.Add("GET /health");
    if (lifecycleShutdownRequest is null) missing.Add("POST /_rabiroute/host/shutdown");
    return $"missing={string.Join(", ", missing)}; observed={observed}";
}
var lifecycleServer = Task.Run(async () =>
{
    while (lifecycleHealthRequest is null || lifecycleShutdownRequest is null)
    {
        using var requestDeadline = CancellationTokenSource.CreateLinkedTokenSource(lifecycleServerCancellation.Token);
        requestDeadline.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            using var connection = await lifecycleListener.AcceptTcpClientAsync(requestDeadline.Token);
            await using var stream = connection.GetStream();
            using var reader = new StreamReader(stream, Encoding.ASCII, false, 4096, leaveOpen: true);
            var requestLine = await reader.ReadLineAsync(requestDeadline.Token);
            if (string.IsNullOrWhiteSpace(requestLine))
            {
                observedLifecyclePaths.Add("<empty-request-line>");
                throw new InvalidDataException($"Lifecycle test server received an empty request line; {LifecycleObservationSummary()}.");
            }
            var requestParts = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var method = requestParts.Length > 0 ? requestParts[0] : "<missing-method>";
            var requestPath = requestParts.Length > 1 ? requestParts[1] : "<missing-path>";
            observedLifecyclePaths.Add($"{method} {requestPath}");
            var requestLines = new List<string> { requestLine };
            while (await reader.ReadLineAsync(requestDeadline.Token) is { } line && line.Length > 0)
            {
                requestLines.Add(line);
            }
            var requestText = string.Join("\n", requestLines);

            string status;
            byte[] bodyBytes;
            if (string.Equals(method, "GET", StringComparison.Ordinal) &&
                string.Equals(requestPath, "/health", StringComparison.Ordinal))
            {
                lifecycleHealthRequest ??= requestText;
                await Task.Delay(TimeSpan.FromSeconds(3), requestDeadline.Token);
                status = "200 OK";
                bodyBytes = Encoding.UTF8.GetBytes(
                    $"{{\"applicationGenerationId\":\"{generation}\",\"managerInstanceId\":\"manager-a\"," +
                    $"\"managerBaseUrl\":\"http://127.0.0.1:{lifecyclePort}\",\"health\":{{\"state\":\"healthy\",\"pid\":{managerPid},\"live\":true,\"requiredReady\":true}}}}");
            }
            else if (string.Equals(method, "POST", StringComparison.Ordinal) &&
                     string.Equals(requestPath, "/_rabiroute/host/shutdown", StringComparison.Ordinal))
            {
                lifecycleShutdownRequest ??= requestText;
                status = "202 Accepted";
                bodyBytes = Array.Empty<byte>();
            }
            else
            {
                status = "404 Not Found";
                bodyBytes = Array.Empty<byte>();
            }

            var headerBytes = Encoding.ASCII.GetBytes(
                $"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {bodyBytes.Length}\r\nConnection: close\r\n\r\n");
            var responseBytes = new byte[headerBytes.Length + bodyBytes.Length];
            Buffer.BlockCopy(headerBytes, 0, responseBytes, 0, headerBytes.Length);
            Buffer.BlockCopy(bodyBytes, 0, responseBytes, headerBytes.Length, bodyBytes.Length);
            await stream.WriteAsync(responseBytes, requestDeadline.Token);
            await stream.FlushAsync(requestDeadline.Token);
        }
        catch (OperationCanceledException) when (requestDeadline.IsCancellationRequested)
        {
            throw new TimeoutException($"Lifecycle test server request deadline expired; {LifecycleObservationSummary()}.");
        }
    }
});
try
{
    using (var lifecycleClient = new ManagerLifecycleClient())
    {
        var probe = await lifecycleClient.ProbeAsync(lifecycleReady, generation, CancellationToken.None);
        Check(probe.State == ManagerProbeState.Healthy, "probe Manager health survives a three-second scheduling delay on an OS-assigned port");
        Check(
            await lifecycleClient.RequestShutdownAsync(lifecycleReady, "host-secret", CancellationToken.None),
            "request protected Manager graceful shutdown");
    }
    await lifecycleServer;
}
finally
{
    lifecycleServerCancellation.Cancel();
    lifecycleListener.Stop();
    if (!lifecycleServer.IsCompleted)
    {
        try { await lifecycleServer; }
        catch when (lifecycleServerCancellation.IsCancellationRequested) { }
    }
}
Check(lifecycleHealthRequest?.StartsWith("GET /health HTTP/1.1", StringComparison.Ordinal) == true, "health probe uses the core-owned /health route");
Check(lifecycleShutdownRequest?.StartsWith("POST /_rabiroute/host/shutdown HTTP/1.1", StringComparison.Ordinal) == true, "shutdown uses the Host-only route");
Check(lifecycleShutdownRequest?.Contains("x-rabiroute-host-token: host-secret", StringComparison.OrdinalIgnoreCase) == true, "shutdown carries the generation secret");
Check(RabiRoute.WindowsHost.HostEntry.ParseCommand(new[] { "--command", "status" }) == "status", "accept formal lifecycle command");
Check(RabiRoute.WindowsHost.HostEntry.ParseCommand(new[] { "--command" }) == "invalid", "reject incomplete formal lifecycle command");
Check(RabiRoute.WindowsHost.HostEntry.ParseCommand(new[] { "--help" }) == "invalid", "reject unsupported arguments instead of treating them as activation");
Check(RabiRoute.WindowsHost.HostEntry.ParseCommand(new[] { "--command", "quit", "--allow-unfenced-quit" }) == "invalid", "reject retired unfenced quit escape hatch");
foreach (var legacyAlias in new[] { "--quit", "--restart", "--status", "--activate" })
{
    Check(RabiRoute.WindowsHost.HostEntry.ParseCommand(new[] { legacyAlias }) == "invalid", $"reject lifecycle alias {legacyAlias}");
    Check(RabiRoute.WindowsHost.HostEntry.ParseCommand(new[] { legacyAlias.ToUpperInvariant() }) == "invalid", $"reject case-insensitive lifecycle alias {legacyAlias}");
}

await using (var memory = new MemoryStream())
{
    await HostProtocol.WriteAsync(memory, new HostRequest("quit", generation), CancellationToken.None);
    memory.Position = 0;
    var request = await HostProtocol.ReadAsync<HostRequest>(memory, CancellationToken.None);
    Check(request.Command == "quit" && request.ApplicationGenerationId == generation,
        "length-prefixed fenced control protocol round trip");
}

await using (var responseMemory = new MemoryStream())
{
    await HostProtocol.WriteAsync(
        responseMemory,
        new HostResponse(
            true,
            "backoff",
            ApplicationGenerationId: null,
            ControlFenceGenerationId: generation,
            OperationId: "operation-a",
            AuditPersisted: true),
        CancellationToken.None);
    responseMemory.Position = 0;
    var response = await HostProtocol.ReadAsync<HostResponse>(responseMemory, CancellationToken.None);
    Check(response.OperationId == "operation-a" && response.AuditPersisted == true,
        "Host response correlates the client result with persisted lifecycle audit");
    Check(response.ApplicationGenerationId is null && response.ControlFenceGenerationId == generation,
        "recovering Host publishes a control fence without publishing a stale active generation endpoint");
}

var strictRequestRejected = false;
await using (var strictMemory = new MemoryStream())
{
    await HostProtocol.WriteAsync(
        strictMemory,
        new { Command = "quit", ApplicationGenerationId = generation, ActorKind = "installer" },
        CancellationToken.None);
    strictMemory.Position = 0;
    try { await HostProtocol.ReadAsync<HostRequest>(strictMemory, CancellationToken.None); }
    catch (JsonException) { strictRequestRejected = true; }
}
Check(strictRequestRejected, "Host rejects client-supplied actor identity and other unknown control fields");

var unfencedEscapeRejected = false;
await using (var strictMemory = new MemoryStream())
{
    await HostProtocol.WriteAsync(
        strictMemory,
        new { Command = "quit", ApplicationGenerationId = generation, AllowUnfencedQuit = true },
        CancellationToken.None);
    strictMemory.Position = 0;
    try { await HostProtocol.ReadAsync<HostRequest>(strictMemory, CancellationToken.None); }
    catch (JsonException) { unfencedEscapeRejected = true; }
}
Check(unfencedEscapeRejected, "Host protocol rejects the retired unfenced quit field");

var malformedResponsePipe = $"RabiRoute.Host.Tests.Malformed.{Guid.NewGuid():N}";
var malformedResponseServer = Task.Run(async () =>
{
    await using var server = HostProtocol.CreateServer(malformedResponsePipe);
    await server.WaitForConnectionAsync();
    await HostProtocol.ReadAsync<HostRequest>(server, CancellationToken.None);
    await HostProtocol.WriteAsync(server, new { Unexpected = true }, CancellationToken.None);
});
var malformedResponse = await HostProtocol.SendAsync(
    "status", null, TimeSpan.FromSeconds(5), malformedResponsePipe);
await malformedResponseServer.WaitAsync(TimeSpan.FromSeconds(5));
Check(malformedResponse is null, "Host CLI maps an incompatible response to a stable unreachable result");

var startupCommands = Channel.CreateUnbounded<string>();
var startupWon = await HostRuntime.AwaitStartupOrCommandAsync(
    Task.CompletedTask,
    startupCommands.Reader,
    CancellationToken.None);
Check(startupWon.StartupCompleted && startupWon.Command is null, "completed generation startup wins without a command");
await startupCommands.Writer.WriteAsync("first-command-after-ready");
Check(
    await startupCommands.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(1)) == "first-command-after-ready",
    "generation startup does not leave an orphan channel read that steals the first Host command");
await startupCommands.Writer.WriteAsync("simultaneous-command");
var commandWon = await HostRuntime.AwaitStartupOrCommandAsync(
    Task.CompletedTask,
    startupCommands.Reader,
    CancellationToken.None);
Check(!commandWon.StartupCompleted && commandWon.Command == "simultaneous-command",
    "a command already available when startup completes is preserved");

var failureRaceCommands = Channel.CreateUnbounded<string>();
await failureRaceCommands.Writer.WriteAsync("fenced-quit-racing-with-failure");
var failureRace = await HostRuntime.AwaitFailureOrCommandAsync(
    Task.CompletedTask,
    failureRaceCommands.Reader,
    CancellationToken.None);
Check(!failureRace.FailureCompleted && failureRace.Command == "fenced-quit-racing-with-failure",
    "a command committed concurrently with generation failure is preserved and processed");
var failureOnlyCommands = Channel.CreateUnbounded<string>();
var failureOnly = await HostRuntime.AwaitFailureOrCommandAsync(
    Task.CompletedTask,
    failureOnlyCommands.Reader,
    CancellationToken.None);
Check(failureOnly.FailureCompleted && failureOnly.Command is null,
    "generation failure wins cleanly when no command was consumed");

using (var job = new WindowsJob($"test-{Environment.ProcessId}-{Guid.NewGuid():N}"))
{
using (var child = NativeChildProcess.StartSuspendedInJob(
           job,
           Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
           new[] { "/d", "/c", "ping -n 3 127.0.0.1 > nul & exit 7" },
           Environment.CurrentDirectory,
           new Dictionary<string, string?>()))
{
    Check(job.MemberProcessIds().SequenceEqual(new[] { child.ProcessId }),
        "Host Job reports the exact child handle membership without process enumeration");
    var exitCode = await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    Check(exitCode == 7, "CREATE_SUSPENDED -> AssignProcessToJobObject -> ResumeThread child exit");
}
}

using (var failedStartJob = new WindowsJob($"failed-start-{Environment.ProcessId}-{Guid.NewGuid():N}"))
{
    var process = System.Diagnostics.Process.GetCurrentProcess();
    var handlesBefore = process.HandleCount;
    for (var index = 0; index < 64; index++)
    {
        try
        {
            NativeChildProcess.StartSuspendedInJob(
                failedStartJob,
                Path.Combine(Path.GetTempPath(), $"missing-rabiroute-child-{Guid.NewGuid():N}.exe"),
                Array.Empty<string>(),
                Environment.CurrentDirectory,
                new Dictionary<string, string?>());
        }
        catch (System.ComponentModel.Win32Exception)
        {
        }
    }
    process.Refresh();
    Check(process.HandleCount - handlesBefore < 8,
        "repeated child startup failures deterministically release pipe and process handles");
}

if (failures.Count > 0)
{
    foreach (var failure in failures) Console.Error.WriteLine($"FAIL: {failure}");
    return 1;
}

Console.WriteLine("RabiRouteHost tests passed.");
return 0;

internal sealed class SequenceLifecycleAudit(params bool[] results) : IHostLifecycleAudit
{
    private int _index;
    internal List<HostAuditEvent> Entries { get; } = new();

    public bool Append(HostAuditEvent entry)
    {
        Entries.Add(entry);
        var index = Math.Min(_index, results.Length - 1);
        _index++;
        return results[index];
    }
}
