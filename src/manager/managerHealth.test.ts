import assert from "node:assert/strict";
import test from "node:test";
import { buildManagerHealthSnapshot } from "./managerHealth.js";

const base = {
  pluginReadiness: { state: "ready" as const, missingCapabilities: [] as readonly string[] },
  planStorageReady: true,
  routesReady: true,
  routeReadyCount: 2,
  routeRequiredCount: 2,
  blockedRouteIds: [] as readonly string[],
  failedRouteIds: [] as readonly string[],
  backgroundIncidentCount: 0,
  pid: 4242,
  checkedAt: "2026-08-30T00:00:00.000Z"
};

test("failed source-patched APIs degrade health without restarting unrelated capabilities", () => {
  const health = buildManagerHealthSnapshot({ ...base, sourcePatchesReady: false });
  assert.equal(health.state, "degraded");
  assert.equal(health.live, true);
  assert.equal(health.requiredReady, true);
  assert.match(health.message, /source-patched APIs are unavailable/);
  assert.equal(buildManagerHealthSnapshot({ ...base, sourcePatchesReady: true }).state, "healthy");
});

test("Manager health separates event-loop liveness from required and business readiness", () => {
  assert.deepEqual(buildManagerHealthSnapshot(base), {
    state: "healthy",
    scope: "application_generation",
    checkedAt: base.checkedAt,
    pid: 4242,
    live: true,
    requiredReady: true,
    businessReady: true,
    backgroundState: "healthy",
    backgroundIncidentCount: 0,
    message: "Manager event loop, required capabilities, and enabled Route ingress are ready."
  });
});

test("background incidents remain visible without blocking unrelated ready APIs", () => {
  const health = buildManagerHealthSnapshot({ ...base, backgroundIncidentCount: 3 });
  assert.equal(health.state, "healthy");
  assert.equal(health.requiredReady, true);
  assert.equal(health.businessReady, true);
  assert.equal(health.backgroundState, "degraded");
  assert.equal(health.backgroundIncidentCount, 3);
  assert.match(health.message, /background incidents=3/);
  assert.equal(buildManagerHealthSnapshot({ ...base, backgroundIncidentCount: 3, planStorageReady: false }).state, "degraded");
});

test("missing required capabilities are not hidden inside generic degraded health", () => {
  const health = buildManagerHealthSnapshot({
    ...base,
    pluginReadiness: {
      state: "degraded",
      missingCapabilities: ["manager.core@1"]
    }
  });

  assert.equal(health.live, true);
  assert.equal(health.requiredReady, false);
  assert.equal(health.businessReady, true);
  assert.equal(health.state, "degraded");
  assert.match(health.message, /manager\.core@1/);
});

test("optional plugin and Route degradation preserve required generation readiness", () => {
  const optionalPlugin = buildManagerHealthSnapshot({
    ...base,
    pluginReadiness: { state: "degraded", missingCapabilities: [] }
  });
  const routeDegraded = buildManagerHealthSnapshot({
    ...base,
    routesReady: false,
    routeReadyCount: 1,
    blockedRouteIds: ["needs-login"]
  });

  assert.equal(optionalPlugin.requiredReady, true);
  assert.equal(optionalPlugin.state, "degraded");
  assert.equal(routeDegraded.requiredReady, true);
  assert.equal(routeDegraded.businessReady, false);
  assert.equal(routeDegraded.state, "degraded");
});

test("plan storage startup blocks business readiness without rejecting the required generation", () => {
  const health = buildManagerHealthSnapshot({
    ...base,
    planStorageReady: false
  });

  assert.equal(health.live, true);
  assert.equal(health.requiredReady, true);
  assert.equal(health.businessReady, false);
  assert.equal(health.state, "degraded");
  assert.match(health.message, /plan storage startup recovery is not ready/i);
});
