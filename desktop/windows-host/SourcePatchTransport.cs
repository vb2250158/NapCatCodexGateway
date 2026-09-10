using System.Net;
using System.Text;
using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal static class SourcePatchTransport
{
    internal const int MaximumRequestBytes = 16 * 1024;
    private const int MaximumResponseBytes = 48 * 1024;

    internal static bool IsCommand(string? command) => command is "source-patch" or "source-patch-reconcile";
    internal static bool IsWebCommand(string? command) => command is "web-patch" or "web-patch-reconcile";

    internal static JsonElement ReadRequest(string? filename)
    {
        if (string.IsNullOrWhiteSpace(filename) || !Path.IsPathFullyQualified(filename))
            throw new InvalidDataException("A source patch requires an absolute request-file path.");
        using var stream = File.OpenRead(filename);
        if (stream.Length > MaximumRequestBytes) throw new InvalidDataException("Source patch request exceeds 16384 bytes.");
        var bytes = new byte[MaximumRequestBytes + 1];
        var received = 0;
        while (received < bytes.Length)
        {
            var count = stream.Read(bytes, received, bytes.Length - received);
            if (count == 0) break;
            received += count;
        }
        if (received > MaximumRequestBytes) throw new InvalidDataException("Source patch request exceeds 16384 bytes.");
        using var document = JsonDocument.Parse(bytes.AsMemory(0, received));
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Source patch request must be an object.");
        return document.RootElement.Clone();
    }

    internal static bool Matches(ManagerReady ready, JsonElement payload, bool webPatch = false) =>
        payload.ValueKind == JsonValueKind.Object &&
        ReadString(payload, "applicationGenerationId") == ready.ApplicationGenerationId &&
        ReadString(payload, "managerInstanceId") == ready.ManagerInstanceId &&
        !string.IsNullOrWhiteSpace(ReadString(payload, "operationId")) &&
        (webPatch || !string.IsNullOrWhiteSpace(ReadString(payload, "moduleId"))) &&
        !string.IsNullOrWhiteSpace(ReadString(payload, "pluginGenerationId"));

    internal static async Task<HostResponse> SendAsync(
        ManagerReady ready, string controlToken, JsonElement payload, bool reconcile, CancellationToken cancellationToken, bool webPatch = false)
    {
        var operationId = ReadString(payload, "operationId");
        HostResponse Result(bool ok, string state, string message, JsonElement? body = null) => new(
            ok, state, message, ApplicationGenerationId: ready.ApplicationGenerationId,
            ManagerInstanceId: ready.ManagerInstanceId, ManagerBaseUrl: ready.BaseUrl,
            SourcePatchOperationId: webPatch ? null : operationId, SourcePatch: webPatch ? null : body,
            WebPatchOperationId: webPatch ? operationId : null, WebPatch: webPatch ? body : null);
        if (!Matches(ready, payload, webPatch)) return Result(false, "stale_generation", "Patch identity does not match the active Manager.");
        if (!Uri.TryCreate(ready.BaseUrl, UriKind.Absolute, out var endpoint) || endpoint.Scheme != Uri.UriSchemeHttp
            || !IPAddress.TryParse(endpoint.Host, out var address) || !IPAddress.IsLoopback(address))
            return Result(false, "invalid_endpoint", "Source patch control requires the published loopback Manager endpoint.");
        var bytes = Encoding.UTF8.GetBytes(payload.GetRawText());
        if (bytes.Length > MaximumRequestBytes) return Result(false, "invalid_request", "Source patch request is too large.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using var client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false })
        { Timeout = Timeout.InfiniteTimeSpan };
        var route = webPatch ? "/_rabiroute/host/web-patches" : "/_rabiroute/host/source-patches";
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(endpoint, route + (reconcile ? "/reconcile" : "")));
        request.Headers.TryAddWithoutValidation("x-rabiroute-host-token", controlToken);
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var body = new MemoryStream();
            var buffer = new byte[4096];
            while (true)
            {
                var received = await stream.ReadAsync(buffer, timeout.Token);
                if (received == 0) break;
                if (body.Length + received > MaximumResponseBytes) throw new InvalidDataException("Source patch response exceeds its limit.");
                body.Write(buffer, 0, received);
            }
            using var document = JsonDocument.Parse(body.ToArray());
            var receipt = document.RootElement;
            if (webPatch)
            {
                if (response.IsSuccessStatusCode && (!receipt.TryGetProperty("data", out var webReceipt)
                    || ReadString(webReceipt, "operationId") != operationId
                    || ReadString(webReceipt, "state") is not ("committed" or "not_started" or "unknown")))
                    return Result(false, "web_patch_unconfirmed", "Web patch receipt did not match; query the original operation.");
                return Result(response.IsSuccessStatusCode, "web_patch_result", $"Manager returned HTTP {(int)response.StatusCode}.", receipt.Clone());
            }
            if (response.IsSuccessStatusCode && (!receipt.TryGetProperty("data", out var success)
                || success.ValueKind != JsonValueKind.Object || ReadString(success, "moduleId") != ReadString(payload, "moduleId")
                || ReadString(success, "state") is not ("pending" or "committed" or "failed" or "indeterminate")
                || ReadString(success, "commitState") is not ("unknown" or "committed" or "not_started")))
                return Result(false, "source_patch_unconfirmed", "Source patch response did not contain a valid receipt; query the original operation.");
            if (receipt.TryGetProperty("data", out var data) && (ReadString(data, "operationId") != operationId
                || ReadString(data, "moduleId") != ReadString(payload, "moduleId")))
                return Result(false, "source_patch_unconfirmed", "Source patch receipt identity did not match; query the original operation.");
            return Result(response.IsSuccessStatusCode, "source_patch_result", $"Manager returned HTTP {(int)response.StatusCode}.", receipt.Clone());
        }
        catch (Exception exception) when (exception is OperationCanceledException or HttpRequestException or IOException or InvalidDataException or JsonException or InvalidOperationException)
        {
            return Result(false, webPatch ? "web_patch_unconfirmed" : "source_patch_unconfirmed", "Patch forwarding did not confirm an outcome; query the original operation and do not replay.");
        }
    }

    private static string? ReadString(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property)
        && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
}
