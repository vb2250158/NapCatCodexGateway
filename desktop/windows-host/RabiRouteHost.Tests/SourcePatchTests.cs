using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using RabiRoute.WindowsHost;

internal static class SourcePatchTests
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        check(HostEntry.ParseCommand(["--command", "source-patch"]) == "source-patch", "source patch CLI uses the formal command parser");
        check(HostEntry.ParseCommand(["--command", "source-patch-reconcile"]) == "source-patch-reconcile", "source patch reconciliation has a separate command");
        check(HostEntry.ParseCommand(["--command", "web-patch"]) == "web-patch", "web publication uses the formal Host command parser");
        check(HostEntry.ParseCommand(["--command", "web-patch-reconcile"]) == "web-patch-reconcile", "web reconciliation has a separate command");
        check(HostRuntime.RequiresDurableAudit("source-patch") && !HostRuntime.AuditAllowsDispatch("source-patch", false), "source patch forwarding requires durable Host audit");
        var payload = JsonSerializer.SerializeToElement(new
        {
            operationId = "source-operation-test", moduleId = "module.test", applicationGenerationId = "generation-test",
            managerInstanceId = "manager-test", pluginGenerationId = "plugins-test", action = "apply", expectedRevision = 0,
            candidateSha256 = new string('a', 64), contract = new { version = 1 }
        });
        var ready = new ManagerReady(1, "generation-test", "manager-test", 1, "http://127.0.0.1:0", DateTimeOffset.UtcNow.ToString("O"));
        check(SourcePatchTransport.Matches(ready, payload), "source patch verifies both application and Manager identity");
        check(!SourcePatchTransport.Matches(ready with { ManagerInstanceId = "other" }, payload), "source patch rejects a stale Manager identity");
        var stale = await SourcePatchTransport.SendAsync(ready with { ApplicationGenerationId = "other" }, "unused", payload, false, CancellationToken.None);
        check(!stale.Ok && stale.State == "stale_generation", "stale source requests fail before network forwarding");

        var root = Path.Combine(Path.GetTempPath(), $"rabi-source-patch-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var requestPath = Path.Combine(root, "request.json");
            await File.WriteAllTextAsync(requestPath, payload.GetRawText());
            check(SourcePatchTransport.ReadRequest(requestPath).GetRawText() == payload.GetRawText(), "source patch request-file reader preserves the frozen payload");
            await File.WriteAllBytesAsync(requestPath, new byte[SourcePatchTransport.MaximumRequestBytes + 1]);
            var refused = false;
            try { SourcePatchTransport.ReadRequest(requestPath); } catch (InvalidDataException) { refused = true; }
            check(refused, "source patch request-file size is bounded");
            check(await HostEntry.RunAsync(["--command", "source-patch", "--source-patch-request", requestPath], root, root) == 64,
                "invalid source patch input returns an error without entering Host lifecycle");
        }
        finally
        {
            if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(root)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Unsafe source patch fixture cleanup.");
            Directory.Delete(root, true);
        }

        await using (var wire = new MemoryStream())
        {
            await HostProtocol.WriteAsync(wire, new HostRequest("source-patch", "generation-test", payload), CancellationToken.None);
            wire.Position = 0;
            var decoded = await HostProtocol.ReadAsync<HostRequest>(wire, CancellationToken.None);
            check(decoded.SourcePatch?.GetProperty("operationId").GetString() == "source-operation-test", "Host pipe preserves source operation identity");
        }

        foreach (var mode in new[] { "apply", "reconcile", "pending", "missing", "wrong", "oversize", "web", "web-reconcile", "web-wrong" })
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var token = Guid.NewGuid().ToString("N");
            try
            {
                var endpoint = (IPEndPoint)listener.LocalEndpoint;
                var active = ready with { BaseUrl = $"http://127.0.0.1:{endpoint.Port}" };
                var server = RespondAsync(listener, payload, token, mode, check, timeout.Token);
                var isWeb = mode.StartsWith("web", StringComparison.Ordinal);
                var result = await SourcePatchTransport.SendAsync(active, token, payload, mode.EndsWith("reconcile", StringComparison.Ordinal), timeout.Token, isWeb);
                await server;
                var confirmedEnvelope = mode is "apply" or "reconcile" or "pending" or "web" or "web-reconcile";
                check(result.Ok == confirmedEnvelope, $"source patch transport validates {mode} response");
                check((isWeb ? result.WebPatchOperationId : result.SourcePatchOperationId) == "source-operation-test", $"patch transport keeps original identity for {mode}");
                if (!confirmedEnvelope) check(result.State == (isWeb ? "web_patch_unconfirmed" : "source_patch_unconfirmed"), $"patch {mode} result remains unconfirmed");
                check(!JsonSerializer.Serialize(result).Contains(token, StringComparison.Ordinal), "Host control token never appears in source patch responses");
            }
            finally { listener.Stop(); }
        }
    }

    private static async Task RespondAsync(TcpListener listener, JsonElement expected, string token, string mode, Action<bool, string> check, CancellationToken cancellationToken)
    {
        using var client = await listener.AcceptTcpClientAsync(cancellationToken);
        await using var stream = client.GetStream();
        using var headers = new MemoryStream();
        var single = new byte[1];
        while (headers.Length < 32768)
        {
            await stream.ReadExactlyAsync(single, cancellationToken);
            headers.WriteByte(single[0]);
            var bytes = headers.GetBuffer();
            var length = (int)headers.Length;
            if (length >= 4 && bytes[length - 4] == 13 && bytes[length - 3] == 10 && bytes[length - 2] == 13 && bytes[length - 1] == 10) break;
        }
        var text = Encoding.ASCII.GetString(headers.ToArray());
        var route = mode.StartsWith("web", StringComparison.Ordinal) ? "/_rabiroute/host/web-patches" : "/_rabiroute/host/source-patches";
        if (mode.EndsWith("reconcile", StringComparison.Ordinal)) route += "/reconcile";
        check(text.StartsWith($"POST {route} ", StringComparison.Ordinal), "patch forwards only to its fixed Manager route");
        check(text.Contains($"x-rabiroute-host-token: {token}", StringComparison.OrdinalIgnoreCase), "source patch forwarding carries private Host authority");
        var contentLength = text.Split("\r\n").First(line => line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
        var body = new byte[int.Parse(contentLength.Split(':', 2)[1].Trim())];
        await stream.ReadExactlyAsync(body, cancellationToken);
        check(Encoding.UTF8.GetString(body) == expected.GetRawText(), "source patch HTTP forwarding does not rewrite the request payload");
        var response = mode == "missing" ? "{\"code\":0}" : JsonSerializer.Serialize(new
        {
            code = 0, data = new { operationId = mode is "wrong" or "web-wrong" ? "another-operation" : "source-operation-test", moduleId = "module.test",
                state = mode == "pending" ? "pending" : "committed", commitState = mode == "pending" ? "unknown" : "committed" }
        });
        if (mode == "oversize") response = new string(' ', 65536) + response;
        var responseBytes = Encoding.UTF8.GetBytes(response);
        await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {(mode == "pending" ? "202 Accepted" : "200 OK")}\r\nContent-Type: application/json\r\nContent-Length: {responseBytes.Length}\r\nConnection: close\r\n\r\n"), cancellationToken);
        await stream.WriteAsync(responseBytes, cancellationToken);
    }
}
