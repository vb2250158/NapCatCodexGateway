import { Session, type Profiler } from "node:inspector";
import { performance } from "node:perf_hooks";

export function summarizeCpuProfile(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const totals = new Map<number, number>();
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const id = profile.samples![index];
    totals.set(id, (totals.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 0));
  }
  return [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([id, micros]) => {
    const frame = nodes.get(id)?.callFrame;
    const url = frame?.url ?? "";
    const marker = url.lastIndexOf("/dist/");
    return {
      function: (frame?.functionName ?? "unknown").slice(0, 160),
      file: marker >= 0 ? url.slice(marker + 1) : url.startsWith("node:") ? url : "<external>",
      line: (frame?.lineNumber ?? -1) + 1,
      selfMs: Math.round(micros / 1000)
    };
  });
}

export function startManagerStallDiagnostics(
  record: (detail: { elapsedMs: number; delayedMs: number; frames?: ReturnType<typeof summarizeCpuProfile>; error?: string }) => void,
  durationMs = 180_000
): () => void {
  const session = new Session();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const started = performance.now();
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try { session.disconnect(); } catch {}
  };
  const next = () => {
    if (stopped) return;
    const expected = performance.now() + 10_000;
    timer = setTimeout(() => {
      if (stopped) return;
      const elapsedMs = Math.round(performance.now() - started);
      const delayedMs = Math.max(0, Math.round(performance.now() - expected));
      session.post("Profiler.stop", (error, result) => {
        if (stopped) return;
        record({ elapsedMs, delayedMs, ...(error ? { error: error.message } : { frames: summarizeCpuProfile(result.profile) }) });
        if (error || elapsedMs >= durationMs) { stop(); return; }
        session.post("Profiler.start", startError => {
          if (startError) { stop(); return; }
          next();
        });
      });
    }, 10_000);
    timer.unref();
  };
  try {
    session.connect();
    session.post("Profiler.enable");
    session.post("Profiler.setSamplingInterval", { interval: 10_000 });
    session.post("Profiler.start", error => {
      if (error) { record({ elapsedMs: 0, delayedMs: 0, error: error.message }); stop(); return; }
      next();
    });
  } catch (error) {
    record({ elapsedMs: 0, delayedMs: 0, error: error instanceof Error ? error.message : String(error) });
    stop();
  }
  return stop;
}
