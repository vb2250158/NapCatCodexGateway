import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const PEER_RPC_CAPABILITY = "peer-rpc-v1";
export const PEER_RPC_PATH = "/api/rabilink/peer/receive";
export const PEER_RPC_MAX_BYTES = 1024 * 1024;
export type PeerIdentity = { deviceId: string; generation: string; instanceId: string };
export type PeerRequest = {
  requestId: string; targetDeviceId: string; generation?: string;
  capability: string; operation: string; input: unknown; expiresAt: number;
};
export type PeerReply = {
  requestId: string; identity: PeerIdentity; ok: boolean; data?: unknown; error?: string;
};
export type PeerPacket = { version: 1; iv: string; data: string; tag: string };

// The application is the trust boundary. Encrypt LAN and Relay payloads alike;
// an application member is not a separately authenticated individual device.
function key(token: string): Buffer {
  if (!token.trim()) throw new Error("RabiLink application is not configured.");
  return createHash("sha256").update("rabi-peer-rpc-v1\0").update(token).digest();
}
export function sealPeerPacket(value: unknown, token: string): PeerPacket {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > PEER_RPC_MAX_BYTES) throw new Error("Peer payload exceeds 1 MiB.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(token), iv);
  cipher.setAAD(Buffer.from(PEER_RPC_CAPABILITY));
  return { version: 1, iv: iv.toString("base64"),
    data: Buffer.concat([cipher.update(bytes), cipher.final()]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64") };
}
export function openPeerPacket<T>(value: unknown, token: string): T {
  const packet = value as PeerPacket;
  if (!packet || packet.version !== 1 || typeof packet.data !== "string"
    || typeof packet.iv !== "string" || typeof packet.tag !== "string"
    || packet.data.length > Math.ceil(PEER_RPC_MAX_BYTES / 3) * 4) throw new Error("Invalid peer packet.");
  const iv = Buffer.from(packet.iv, "base64");
  const tag = Buffer.from(packet.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid peer packet.");
  const decipher = createDecipheriv("aes-256-gcm", key(token), iv);
  decipher.setAAD(Buffer.from(PEER_RPC_CAPABILITY));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(packet.data, "base64")), decipher.final()]).toString());
}

export type PeerOperation = {
  capability: string; operation: string;
  execute(input: unknown): Promise<unknown> | unknown;
};
export class RabiPeerDispatcher {
  constructor(private readonly options: {
    token(): string; identity(): PeerIdentity;
    allowed(): string[]; operations: PeerOperation[];
    onResult?(event: { requestId: string; capability: string; operation: string; ok: boolean }): void;
  }) {}

  async receive(packet: unknown): Promise<PeerPacket> {
    const token = this.options.token();
    const request = openPeerPacket<PeerRequest>(packet, token);
    const identity = this.options.identity();
    if (!request || typeof request.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.requestId)
      || !Number.isFinite(request.expiresAt) || request.expiresAt < Date.now()
      || request.expiresAt > Date.now() + 120_000) throw new Error("Invalid or expired peer request.");
    const reply: PeerReply = { requestId: request.requestId, identity, ok: false };
    try {
      if (request.targetDeviceId !== identity.deviceId) throw new Error("peer_target_changed");
      const describe = request.capability === "system" && request.operation === "describe";
      if (!describe && request.generation !== identity.generation) throw new Error("peer_generation_changed");
      const registered = this.options.operations.find(item => item.capability === request.capability && item.operation === request.operation);
      if (describe) {
        reply.data = { identity, operations: this.options.operations
          .filter(item => this.options.allowed().includes(`${item.capability}.${item.operation}`))
          .map(({ capability, operation }) => ({ capability, operation, readOnly: true })) };
      } else {
        if (!registered || !this.options.allowed().includes(`${request.capability}.${request.operation}`)) throw new Error("peer_operation_denied");
        reply.data = await registered.execute(request.input);
      }
      if (this.options.identity().generation !== identity.generation || this.options.token() !== token) throw new Error("peer_generation_changed");
      reply.ok = true;
    } catch (error) {
      // Business errors can contain local paths or content. Only protocol errors cross the boundary.
      const message = error instanceof Error ? error.message : "";
      reply.error = /^peer_[a-z_]+$/.test(message) ? message : "peer_operation_failed";
      delete reply.data;
    }
    this.options.onResult?.({ requestId: request.requestId, capability: request.capability, operation: request.operation, ok: reply.ok });
    return sealPeerPacket(reply, token);
  }
}
