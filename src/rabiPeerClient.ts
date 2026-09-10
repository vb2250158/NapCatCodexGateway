import { randomUUID } from "node:crypto";
import { RabiPeerDirect } from "./rabiPeerDirect.js";
import { openPeerPacket, sealPeerPacket, PEER_RPC_CAPABILITY, PEER_RPC_PATH,
  type PeerIdentity, type PeerPacket, type PeerReply, type PeerRequest } from "./rabiPeerProtocol.js";

export type RabiPeer = { id: string; guid?: string; deviceKind?: string; online: boolean; capabilities: string[]; peerUrls: string[] };
export type PeerCall = { targetDeviceId: string; capability: string; operation: string; input?: unknown };
export type PeerTransport = "lan" | "p2p" | "relay";

async function post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<PeerPacket> {
  const response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Peer transport HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty peer reply.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 1_500_000) throw new Error("Peer response too large.");
      chunks.push(Buffer.from(result.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { await reader.cancel().catch(() => {}); }
}
function lanUrl(raw: string): string {
  const url = new URL(raw);
  const octets = url.hostname.split(".").map(Number);
  const [a, b] = octets;
  const privateAddress = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
  if (url.protocol !== "http:" || !privateAddress || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid peer LAN endpoint.");
  return `${url.origin}${PEER_RPC_PATH}`;
}
export class RabiPeerClient {
  constructor(private readonly options: {
    peers(): Promise<RabiPeer[]>; relay(): { url: string; token: string };
    direct: RabiPeerDirect;
  }) {}
  async call(call: PeerCall): Promise<{ transport: PeerTransport; reply: PeerReply }> {
    if (!call || typeof call.targetDeviceId !== "string" || typeof call.capability !== "string" || typeof call.operation !== "string") throw new Error("Invalid peer call.");
    const relay = this.options.relay();
    const peer = (await this.options.peers()).find(item => item.id === call.targetDeviceId || item.guid === call.targetDeviceId);
    if (!peer?.online || !peer.capabilities.includes(PEER_RPC_CAPABILITY)) throw new Error("Target is offline or does not support peer RPC.");
    const targetDeviceId = peer.id;
    const request = (capability: string, operation: string, input: unknown, generation?: string): PeerRequest => ({
      requestId: randomUUID(), targetDeviceId, capability, operation, input, generation, expiresAt: Date.now() + 90_000
    });
    const decode = (packet: PeerPacket, sent: PeerRequest): PeerReply => {
      const reply = openPeerPacket<PeerReply>(packet, relay.token);
      if (reply.requestId !== sent.requestId || reply.identity?.deviceId !== targetDeviceId || !reply.identity.generation || !reply.identity.instanceId) throw new Error("Peer reply identity mismatch.");
      if (sent.generation && sent.generation !== reply.identity.generation) throw new Error("Peer generation changed; discover again.");
      return reply;
    };
    const relayExchange = (packet: PeerPacket) => post(`${relay.url.replace(/\/+$/, "")}/api/rabilink/peer/proxy`,
      { targetDeviceId, packet }, { "x-rabilink-token": relay.token }, 30_000);
    const describe = request("system", "describe", {});
    let identity: PeerIdentity | undefined;
    let selectedLan: string | undefined;
    for (const address of peer.peerUrls.slice(0, 4)) {
      try {
        const url = lanUrl(address);
        const reply = decode(await post(url, sealPeerPacket(describe, relay.token), {}, 2_000), describe);
        if (!reply.ok) continue;
        identity = reply.identity;
        selectedLan = url;
        break;
      } catch { /* LAN discovery is read-only; use the next registered address. */ }
    }
    if (!identity) {
      const reply = decode(await relayExchange(sealPeerPacket(describe, relay.token)), describe);
      if (!reply.ok) throw new Error(reply.error || "Peer discovery failed.");
      identity = reply.identity;
    }
    const sent = request(call.capability, call.operation, call.input ?? {}, identity.generation);
    const packet = sealPeerPacket(sent, relay.token);
    if (selectedLan) {
      try { return { transport: "lan", reply: decode(await post(selectedLan, packet, {}, 10_000), sent) }; }
      catch { /* Only registered read operations are exposed by this protocol version. */ }
    }
    try {
      const result = await this.options.direct.exchange(packet, async input => {
        const offer = request("transport", "offer", input, identity.generation);
        const reply = decode(await relayExchange(sealPeerPacket(offer, relay.token)), offer);
        if (!reply.ok) throw new Error(reply.error);
        return reply.data as { sdp: string };
      });
      return { transport: "p2p", reply: decode(result, sent) };
    } catch { /* Bounded P2P attempt; small read requests may use Relay. */ }
    return { transport: "relay", reply: decode(await relayExchange(packet), sent) };
  }
}
