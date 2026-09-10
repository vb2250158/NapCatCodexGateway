export function webReleaseQuery(): string {
  const revision = typeof document === "undefined" ? null : document.documentElement?.getAttribute("data-rabi-web-release");
  return revision && /^[a-f0-9]{64}$/.test(revision) ? `?webRelease=${revision}` : "";
}
