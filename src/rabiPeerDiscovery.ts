export type DiscoveredRabiPeer = {
  id: string; guid?: string; name: string; deviceKind: string; online: boolean; capabilities: string[]; peerUrls: string[];
};
export function peerDeviceKind(value: unknown): string {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z][a-z0-9._-]{0,31}$/.test(kind) ? kind : "unknown";
}

/** Counts registrations, not physical computers. Unknown legacy identities remain unknown. */
export function peerDiscoveryPage<T extends { deviceKind?: string; online: boolean }>(peers: T[], query: URLSearchParams) {
  const kind = query.get("deviceKind");
  const online = query.get("online");
  if (kind !== null && peerDeviceKind(kind) !== kind) throw new Error("Invalid deviceKind filter.");
  if (online !== null && online !== "true" && online !== "false") throw new Error("Invalid online filter.");
  const selected = peers.map(peer => ({ ...peer, deviceKind: peerDeviceKind(peer.deviceKind) }))
    .filter(peer => kind === null || peer.deviceKind === kind)
    .filter(peer => online === null || peer.online === (online === "true"));
  const byDeviceKind: Record<string, number> = Object.create(null);
  for (const peer of selected) byDeviceKind[peer.deviceKind] = (byDeviceKind[peer.deviceKind] ?? 0) + 1;
  return { peers: selected, summary: { total: selected.length, online: selected.filter(peer => peer.online).length, byDeviceKind } };
}
export async function discoverRabiPeers(relay: { url: string; token: string; deviceId: string; deviceGuid: string }): Promise<DiscoveredRabiPeer[]> {
  if (!relay.url.trim() || !relay.token.trim()) throw new Error("RabiLink Relay is not configured.");
  const params = new URLSearchParams({ deviceId: relay.deviceId, deviceGuid: relay.deviceGuid });
  const response = await fetch(`${relay.url.replace(/\/+$/, "")}/api/rabilink/peers?${params}`, {
    headers: { "x-rabilink-token": relay.token }, redirect: "error", signal: AbortSignal.timeout(5_000)
  });
  const body = await response.json() as { peers?: DiscoveredRabiPeer[] };
  if (!response.ok || !Array.isArray(body.peers)) throw new Error("RabiLink device discovery failed.");
  return body.peers.map(peer => ({ ...peer, deviceKind: peerDeviceKind(peer.deviceKind) }));
}
