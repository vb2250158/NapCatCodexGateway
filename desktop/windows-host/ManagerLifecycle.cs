using System.Net;
using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal enum ManagerProbeState
{
    Healthy,
    Degraded,
    Failed
}

internal sealed record ManagerProbeResult(ManagerProbeState State, string Message);

internal sealed class ManagerLifecycleClient : IDisposable
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ShutdownRequestTimeout = TimeSpan.FromSeconds(3);
    private readonly HttpClient _client;

    internal ManagerLifecycleClient()
    {
        _client = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false
        })
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
    }

    internal async Task<ManagerProbeResult> ProbeAsync(
        ManagerReady ready,
        string expectedGenerationId,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ProbeTimeout);
        try
        {
            using var response = await _client.GetAsync(
                new Uri(new Uri(NormalizeBaseUrl(ready.BaseUrl)), "health"),
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token);
            if (response.StatusCode != HttpStatusCode.OK)
            {
                return new ManagerProbeResult(
                    ManagerProbeState.Failed,
                    $"Manager /health returned HTTP {(int)response.StatusCode}.");
            }
            await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var document = await JsonDocument.ParseAsync(body, cancellationToken: timeout.Token);
            return ValidateHealth(document.RootElement, ready, expectedGenerationId);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ManagerProbeResult(ManagerProbeState.Failed, "Manager /health timed out.");
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or UriFormatException)
        {
            return new ManagerProbeResult(ManagerProbeState.Failed, $"Manager /health failed: {exception.Message}");
        }
    }

    internal async Task<bool> RequestShutdownAsync(
        ManagerReady ready,
        string controlToken,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ShutdownRequestTimeout);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(new Uri(NormalizeBaseUrl(ready.BaseUrl)), "_rabiroute/host/shutdown"));
        request.Headers.TryAddWithoutValidation("x-rabiroute-host-token", controlToken);
        try
        {
            using var response = await _client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token);
            return response.StatusCode == HttpStatusCode.Accepted;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or UriFormatException)
        {
            return false;
        }
    }

    internal static ManagerProbeResult ValidateHealth(
        JsonElement meta,
        ManagerReady ready,
        string expectedGenerationId)
    {
        if (meta.ValueKind != JsonValueKind.Object)
        {
            return new ManagerProbeResult(ManagerProbeState.Failed, "Manager /health is not an object.");
        }

        var generationId = ReadString(meta, "applicationGenerationId");
        var managerInstanceId = ReadString(meta, "managerInstanceId");
        var managerBaseUrl = ReadString(meta, "managerBaseUrl");
        var managerPid = ReadUInt32(meta, "health", "pid");
        if (!string.Equals(generationId, expectedGenerationId, StringComparison.Ordinal) ||
            !string.Equals(managerInstanceId, ready.ManagerInstanceId, StringComparison.Ordinal) ||
            !string.Equals(NormalizeBaseUrl(managerBaseUrl), NormalizeBaseUrl(ready.BaseUrl), StringComparison.OrdinalIgnoreCase) ||
            managerPid != ready.Pid)
        {
            return new ManagerProbeResult(
                ManagerProbeState.Failed,
                "Manager /health identity does not match the active application generation.");
        }

        var live = ReadBoolean(meta, "health", "live");
        var requiredReady = ReadBoolean(meta, "health", "requiredReady");
        if (live != true)
        {
            return new ManagerProbeResult(ManagerProbeState.Failed, "Manager /health did not confirm event-loop liveness.");
        }
        if (requiredReady != true)
        {
            return new ManagerProbeResult(ManagerProbeState.Failed, "Manager /health reported required capabilities unavailable.");
        }
        var healthState = ReadString(meta, "health", "state");
        return healthState switch
        {
            "healthy" => new ManagerProbeResult(ManagerProbeState.Healthy, "Manager is healthy."),
            "degraded" => new ManagerProbeResult(ManagerProbeState.Degraded, "Manager is live and required-ready, but optional plugins or business integrations are degraded."),
            _ => new ManagerProbeResult(ManagerProbeState.Failed, $"Manager /health reported an invalid health state: {healthState}.")
        };
    }

    private static string ReadString(JsonElement parent, string property)
    {
        return parent.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
    }

    private static string ReadString(JsonElement parent, string objectProperty, string property)
    {
        return parent.TryGetProperty(objectProperty, out var nested) && nested.ValueKind == JsonValueKind.Object
            ? ReadString(nested, property)
            : string.Empty;
    }

    private static uint? ReadUInt32(JsonElement parent, string objectProperty, string property)
    {
        if (!parent.TryGetProperty(objectProperty, out var nested) || nested.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        return nested.TryGetProperty(property, out var value) && value.TryGetUInt32(out var parsed)
            ? parsed
            : null;
    }

    private static bool? ReadBoolean(JsonElement parent, string objectProperty, string property)
    {
        if (!parent.TryGetProperty(objectProperty, out var nested) || nested.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        if (!nested.TryGetProperty(property, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static string NormalizeBaseUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        return value.Trim().TrimEnd('/') + "/";
    }

    public void Dispose() => _client.Dispose();
}

internal sealed class RestartFailureWindow
{
    internal static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(15);
    private readonly int _limit;
    private readonly TimeSpan _window;
    private readonly Queue<DateTimeOffset> _failures = new();

    internal RestartFailureWindow(int limit, TimeSpan window)
    {
        if (limit <= 0) throw new ArgumentOutOfRangeException(nameof(limit));
        if (window <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(window));
        _limit = limit;
        _window = window;
    }

    internal int Record(DateTimeOffset now)
    {
        Expire(now);
        _failures.Enqueue(now);
        return _failures.Count;
    }

    internal bool IsOpen(DateTimeOffset now)
    {
        Expire(now);
        return _failures.Count >= _limit;
    }

    internal void Clear() => _failures.Clear();

    private void Expire(DateTimeOffset now)
    {
        var oldestAllowed = now - _window;
        while (_failures.Count > 0 && _failures.Peek() < oldestAllowed)
        {
            _failures.Dequeue();
        }
    }
}
