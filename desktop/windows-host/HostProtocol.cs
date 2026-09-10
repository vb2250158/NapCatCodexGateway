using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RabiRoute.WindowsHost;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record HostRequest(
    string? Command,
    string? ApplicationGenerationId = null,
    JsonElement? SourcePatch = null,
    JsonElement? WebPatch = null);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record HostResponse(
    bool Ok,
    string State,
    string? Message = null,
    string? ApplicationGenerationId = null,
    string? ControlFenceGenerationId = null,
    string? ManagerInstanceId = null,
    string? ManagerBaseUrl = null,
    uint? ManagerPid = null,
    uint? TrayPid = null,
    string? TrayBoundManagerInstanceId = null,
    IReadOnlyList<uint>? JobMemberPids = null,
    string? OperationId = null,
    bool? AuditPersisted = null,
    string? SourcePatchOperationId = null,
    JsonElement? SourcePatch = null,
    string? WebPatchOperationId = null,
    JsonElement? WebPatch = null);

internal static class HostIdentity
{
    internal static string CurrentUserKey()
    {
        var identity = WindowsIdentity.GetCurrent();
        var source = identity.User?.Value ?? identity.Name;
        return UserKey(source);
    }

    internal static string UserKey(string source)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(source));
        return Convert.ToHexString(digest.AsSpan(0, 8));
    }

    internal static string MutexName => $"Local\\RabiRoute.Host.{CurrentUserKey()}";
    internal static string PipeName => $"RabiRoute.Host.{CurrentUserKey()}";
}

internal static class HostProtocol
{
    private const int MaximumMessageBytes = 64 * 1024;

    internal static async Task WriteAsync<T>(Stream stream, T value, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length > MaximumMessageBytes)
        {
            throw new InvalidDataException("Host control message is too large.");
        }

        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    internal static async Task<T> ReadAsync<T>(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[sizeof(int)];
        await stream.ReadExactlyAsync(header, cancellationToken);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > MaximumMessageBytes)
        {
            throw new InvalidDataException("Invalid host control message length.");
        }

        var payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken);
        return JsonSerializer.Deserialize<T>(payload)
            ?? throw new InvalidDataException("Host control message is empty.");
    }

    internal static NamedPipeServerStream CreateServer(string? pipeName = null) => new(
        pipeName ?? HostIdentity.PipeName,
        PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

    internal static async Task<HostResponse?> SendAsync(
        string command,
        string? applicationGenerationId,
        TimeSpan timeout,
        string? pipeName = null,
        JsonElement? sourcePatch = null,
        JsonElement? webPatch = null)
    {
        using var timeoutSource = new CancellationTokenSource(timeout);
        await using var client = new NamedPipeClientStream(
            ".",
            pipeName ?? HostIdentity.PipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification);
        try
        {
            await client.ConnectAsync(timeoutSource.Token);
            await WriteAsync(client, new HostRequest(command, applicationGenerationId, sourcePatch, webPatch), timeoutSource.Token);
            return await ReadAsync<HostResponse>(client, timeoutSource.Token);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (InvalidDataException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }
}
