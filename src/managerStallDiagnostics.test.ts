import assert from "node:assert/strict";
import test from "node:test";
import { startManagerStallDiagnostics, summarizeCpuProfile } from "./managerStallDiagnostics.js";

test("startup CPU summaries count samples without exposing absolute paths or values", () => {
  const result = summarizeCpuProfile({ startTime: 0, endTime: 30_000,
    nodes: [{ id: 1, callFrame: { functionName: "load", scriptId: "1", url: "file:///private/install/dist/worker.js", lineNumber: 4, columnNumber: 0 } },
      { id: 2, callFrame: { functionName: "external", scriptId: "2", url: "file:///private/secret.js", lineNumber: 1, columnNumber: 0 } }],
    samples: [1, 2, 1], timeDeltas: [10_000, 5000, 15_000] });
  assert.equal(result[0].selfMs, 25);
  assert.equal(result[0].file, "dist/worker.js");
  assert.equal(result[0].line, 5);
  assert.equal(result[1].file, "<external>");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("bounded startup sampling emits a CPU summary without a debug listener", async () => {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { stop(); reject(new Error("CPU sample did not arrive")); }, 30_000);
    const stop = startManagerStallDiagnostics(sample => {
      clearTimeout(deadline);
      try {
        assert.equal(sample.error, undefined);
        assert.ok(sample.frames?.length);
        assert.ok(sample.elapsedMs >= 10_000);
        stop();
        resolve();
      } catch (error) { stop(); reject(error); }
    }, 1);
  });
});
