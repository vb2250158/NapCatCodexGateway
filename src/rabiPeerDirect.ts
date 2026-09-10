import { RTCPeerConnection, type RTCDataChannel } from "werift";
import type { PeerPacket } from "./rabiPeerProtocol.js";

const CHANNEL = "rabi.peer.rpc.v1";
const MAX_WIRE_BYTES = 1_500_000;
const END_PACKET = "__rabi_peer_packet_end__";
function sendPacket(channel: RTCDataChannel, value: unknown): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_WIRE_BYTES) throw new Error("Peer wire limit exceeded.");
  for (let offset = 0; offset < text.length; offset += 12_000) channel.send(text.slice(offset, offset + 12_000));
  channel.send(END_PACKET);
}
function receivePacket(channel: RTCDataChannel, accept: (value: PeerPacket) => void, fail: () => void): void {
  let text = "";
  let complete = false;
  channel.onMessage.subscribe(data => {
    if (complete) return;
    const chunk = typeof data === "string" ? data : data.toString();
    if (chunk !== END_PACKET) text += chunk;
    if (Buffer.byteLength(text) > MAX_WIRE_BYTES) { complete = true; fail(); return; }
    if (chunk !== END_PACKET) return;
    complete = true;
    try { accept(JSON.parse(text)); } catch { fail(); }
  });
}
function validSdp(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 60 * 1024
    || !value.startsWith("v=0") || !value.includes("m=application ")
    || / typ relay(?: |\r|\n|$)/.test(value) || /^m=(audio|video) /m.test(value)) throw new Error("Invalid direct-only SDP.");
  return value;
}

/** One bounded RPC per connection. No TURN and no background reconnect loop. */
export class RabiPeerDirect {
  private readonly connections = new Set<RTCPeerConnection>();
  private readonly operations = new Set<Promise<void>>();
  private stopped = false;
  constructor(private readonly receive: (packet: unknown) => Promise<PeerPacket>,
    private readonly stunUrls = ["stun:stun.l.google.com:19302"], private readonly timeoutMs = 12_000) {
    if (stunUrls.some(url => !/^stun:[a-zA-Z0-9.\-]+:\d+$/.test(url))) throw new Error("Only STUN is supported.");
  }
  private create(): { peer: RTCPeerConnection; close(): Promise<void>; assertActive(): void } {
    if (this.stopped || this.connections.size >= 8) throw new Error("Peer direct transport unavailable.");
    const peer = new RTCPeerConnection({ iceServers: this.stunUrls.map(urls => ({ urls })) });
    this.connections.add(peer);
    const assertActive = () => {
      if (this.stopped || !this.connections.has(peer)) throw new Error("Peer connection is closed.");
    };
    const close = async () => {
      clearTimeout(timer);
      if (this.connections.delete(peer)) await peer.close();
    };
    const timer = setTimeout(() => { void close(); }, this.timeoutMs + 5_000);
    timer.unref();
    peer.connectionStateChange.subscribe(state => {
      if (["failed", "disconnected", "closed"].includes(state)) void close();
    });
    return { peer, close, assertActive };
  }
  async offer(input: unknown): Promise<{ sdp: string }> {
    const sdp = validSdp((input as { sdp?: unknown })?.sdp);
    const { peer, close, assertActive } = this.create();
    let claimed = false;
    peer.onDataChannel.subscribe(channel => {
      if (claimed || channel.label !== CHANNEL || !channel.ordered) { void close(); return; }
      claimed = true;
      receivePacket(channel, packet => {
        const operation = this.receive(packet).then(reply => {
          assertActive();
          sendPacket(channel, reply);
        }).catch(() => close());
        this.operations.add(operation);
        void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
      }, () => { void close(); });
    });
    try {
      await peer.setRemoteDescription({ type: "offer", sdp });
      assertActive();
      await peer.setLocalDescription(await peer.createAnswer());
      assertActive();
      return { sdp: peer.localDescription!.sdp };
    } catch (error) { await close(); throw error; }
  }
  async exchange(packet: PeerPacket, signal: (offer: { sdp: string }) => Promise<{ sdp: string }>): Promise<PeerPacket> {
    const { peer, close, assertActive } = this.create();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const channel = peer.createDataChannel(CHANNEL);
          const opened = channel.stateChange.watch(state => state === "open", this.timeoutMs);
          // Observe rejection even when signalling fails before we reach the await.
          void opened.catch(() => {});
          const reply = new Promise<PeerPacket>((resolve, reject) => {
            receivePacket(channel, resolve, () => reject(new Error("Invalid direct peer reply.")));
          });
          await peer.setLocalDescription(await peer.createOffer());
          assertActive();
          const answer = await signal({ sdp: peer.localDescription!.sdp });
          assertActive();
          await peer.setRemoteDescription({ type: "answer", sdp: validSdp(answer.sdp) });
          await opened;
          sendPacket(channel, packet);
          return await reply;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Peer direct connection timed out.")), this.timeoutMs); })
      ]);
    } finally { clearTimeout(timer); await close(); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.connections].map(async peer => { this.connections.delete(peer); await peer.close(); }));
    await Promise.allSettled([...this.operations]);
  }
}
