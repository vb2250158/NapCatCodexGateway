import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { RTCPeerConnection } from "werift";

export const DIRECT_VIDEO_CHANNEL = "rabi.h264.v1";
export const DIRECT_VIDEO_SIGNAL_MAX_BYTES = 64 * 1024;

/** Signalling accepts SDP only. Camera bytes are accepted exclusively over DTLS/SCTP. */
export function validateDirectVideoOffer(value: unknown): { sdp: string; deviceId: string } {
  if (!value || typeof value !== "object") throw new Error("Video offer is required.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["sdp", "deviceId"].includes(key))) throw new Error("Only SDP and deviceId are accepted.");
  if (typeof input.deviceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.deviceId)) throw new Error("Invalid video device identity.");
  if (typeof input.sdp !== "string" || Buffer.byteLength(input.sdp) > 60 * 1024
      || !input.sdp.startsWith("v=0") || !input.sdp.includes("m=application ")
      || / typ relay(?: |\r|\n|$)/.test(input.sdp)
      || /^m=(audio|video) /m.test(input.sdp)) throw new Error("A direct-only data-channel SDP offer is required.");
  return { sdp: input.sdp, deviceId: input.deviceId };
}

type Session = {
  id: string; deviceId: string; peer: RTCPeerConnection; output?: WriteStream;
  bytes: number; state: string; timer: NodeJS.Timeout; file: string; closed: boolean;
};

/** Manager owns received files and bounded sessions; the Relay only carries offer/answer. */
export class RabiDirectVideo {
  private readonly sessions = new Map<string, Session>();
  private readonly closing = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly directory: string,
    private readonly stunUrls: string[] = ["stun:stun.l.google.com:19302"],
    private readonly maxBytes = 256 * 1024 * 1024) {
    if (stunUrls.some(url => !/^stun:[a-zA-Z0-9.\-]+:\d+$/.test(url))) throw new Error("Only STUN URLs are allowed; TURN is disabled.");
  }

  status() {
    return [...this.sessions.values()].map(({ id, deviceId, bytes, state }) => ({ id, deviceId, bytes, state, relay: false }));
  }

  async offer(value: unknown) {
    const input = validateDirectVideoOffer(value);
    if (this.stopped) throw new Error("Video receiver is stopped.");
    if (this.sessions.size >= 2 || [...this.sessions.values()].some(s => s.deviceId === input.deviceId)) {
      throw new Error("A video session is already active or receiver capacity is reached.");
    }
    const id = randomUUID();
    const peer = new RTCPeerConnection({ iceServers: this.stunUrls.map(urls => ({ urls })), iceUseIpv4: true, iceUseIpv6: true });
    const session: Session = { id, deviceId: input.deviceId, peer, bytes: 0, state: "connecting",
      timer: setTimeout(() => this.close(id, "connection_timeout"), 45_000),
      file: path.join(this.directory, `${id}.h264`), closed: false };
    this.sessions.set(id, session);
    peer.connectionStateChange.subscribe(state => {
      if (["failed", "disconnected", "closed"].includes(state)) this.close(id, state);
    });
    let channelOpened = false;
    peer.onDataChannel.subscribe(channel => {
      if (channelOpened || channel.label !== DIRECT_VIDEO_CHANNEL || !channel.ordered
          || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
        this.close(id, "invalid_channel"); return;
      }
      channelOpened = true;
      channel.onMessage.subscribe(data => {
        if (session.closed) return;
        if (typeof data === "string") {
          if (data === "stop") this.close(id, "stopped");
          else this.close(id, "invalid_message");
          return;
        }
        if (!data.length || data.length > 16 * 1024 || session.bytes + data.length > this.maxBytes) {
          this.close(id, "size_limit"); return;
        }
        try {
          if (!session.output) {
            mkdirSync(this.directory, { recursive: true });
            session.output = createWriteStream(session.file, { flags: "wx", highWaterMark: 1024 * 1024 });
            session.output.on("error", () => this.close(id, "storage_error"));
          }
          // Never silently drop H.264 bytes: terminate on storage backpressure.
          const canContinue = session.output.write(data);
          session.bytes += data.length;
          if (!canContinue) { this.close(id, "storage_backpressure"); return; }
          session.state = "receiving";
          clearTimeout(session.timer);
          session.timer = setTimeout(() => this.close(id, "video_timeout"), 15_000);
        } catch { this.close(id, "storage_error"); }
      });
    });
    try {
      await peer.setRemoteDescription({ type: "offer", sdp: input.sdp });
      await peer.setLocalDescription(await peer.createAnswer());
      if (session.closed || !peer.localDescription) throw new Error("Video negotiation expired.");
      return { sessionId: id, type: "answer", sdp: peer.localDescription.sdp, relay: false };
    } catch (error) { this.close(id, "negotiation_failed"); throw error; }
  }

  close(id: string, reason: string) {
    const session = this.sessions.get(id);
    if (!session || session.closed) return;
    session.closed = true;
    session.state = reason;
    clearTimeout(session.timer);
    const finished = new Promise<void>(resolve => {
      if (!session.output || session.output.destroyed) resolve();
      else { session.output.once("close", resolve); session.output.end(); }
    });
    const pair = session.peer.iceTransports[0]?.getSelectedCandidatePair();
    const metadata = { sessionId: id, deviceId: session.deviceId, bytes: session.bytes, state: reason,
      endedAt: new Date().toISOString(), localCandidateType: pair?.local.candidate.match(/ typ (\w+)/)?.[1],
      remoteCandidateType: pair?.remote.candidate.match(/ typ (\w+)/)?.[1], relay: false };
    const saved = finished.then(async () => {
      if (!session.output) return;
      await writeFile(session.file + ".json", JSON.stringify(metadata, null, 2), { flag: "wx" });
    });
    const closing = Promise.allSettled([session.peer.close(), saved]).then(() => {
      this.sessions.delete(id);
      this.closing.delete(closing);
    });
    this.closing.add(closing);
  }

  async stop() {
    this.stopped = true;
    for (const id of this.sessions.keys()) this.close(id, "receiver_stopped");
    await Promise.allSettled([...this.closing]);
  }
}
