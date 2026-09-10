import type { IncomingMessage, ServerResponse } from "node:http";
import { RabiPeerClient, type PeerCall, type RabiPeer } from "../rabiPeerClient.js";
import { RabiPeerDirect } from "../rabiPeerDirect.js";
import { peerDiscoveryPage } from "../rabiPeerDiscovery.js";
import { RabiPeerDispatcher, PEER_RPC_PATH, type PeerIdentity, type PeerOperation } from "../rabiPeerProtocol.js";

export function createRabiPeerRuntime(options: {
  identity(): PeerIdentity; token(): string; allowed(): string[];
  operations: PeerOperation[]; peers(): Promise<RabiPeer[]>;
  relay(): { url: string; token: string };
  readJson(request: IncomingMessage, maxBytes: number): Promise<unknown>;
  json(response: ServerResponse, status: number, body: unknown): void;
  onResult?(event: { requestId: string; capability: string; operation: string; ok: boolean }): void;
}) {
  let active = true;
  const dispatcher: RabiPeerDispatcher = new RabiPeerDispatcher({ ...options,
    allowed: () => [...options.allowed(), "transport.offer"],
    operations: [...options.operations, { capability: "transport", operation: "offer", execute: input => direct.offer(input) }]
  });
  const direct: RabiPeerDirect = new RabiPeerDirect(packet => dispatcher.receive(packet));
  const client = new RabiPeerClient({ peers: options.peers, relay: options.relay, direct });
  const pending = new Set<Promise<void>>();
  const handler = (request: IncomingMessage, url: URL, response: ServerResponse): boolean => {
    if (!url.pathname.startsWith("/api/rabilink/peer/")) return false;
    if (!active) { options.json(response, 503, { error: "Peer runtime is stopping." }); return true; }
    const receive = url.pathname === PEER_RPC_PATH && request.method === "POST";
    const list = url.pathname === "/api/rabilink/peer/list" && request.method === "GET";
    const call = url.pathname === "/api/rabilink/peer/call" && request.method === "POST";
    if (!receive && !list && !call) { options.json(response, 404, { error: "Unknown peer endpoint." }); return true; }
    const address = request.socket.remoteAddress;
    if (!receive && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) {
      options.json(response, 403, { error: "Peer control is loopback-only." }); return true;
    }
    const run = (async () => {
      try {
        if (list) {
          // Validate filters before performing Relay discovery.
          try { peerDiscoveryPage([], url.searchParams); }
          catch { options.json(response, 400, { error: "Use deviceKind and online=true|false filters." }); return; }
          options.json(response, 200, peerDiscoveryPage(await options.peers(), url.searchParams)); return;
        }
        const body = await options.readJson(request, receive ? 1_500_000 : 256_000);
        const result = receive ? await dispatcher.receive(body) : await client.call(body as PeerCall);
        options.json(response, 200, result);
      } catch {
        options.json(response, receive ? 400 : 502, { error: receive ? "Peer request rejected." : "Peer call failed; check target, access and connectivity." });
      }
    })();
    pending.add(run);
    void run.then(() => pending.delete(run), () => pending.delete(run));
    return true;
  };
  return { handler, async stop() { active = false; await direct.stop(); await Promise.allSettled([...pending]); } };
}
