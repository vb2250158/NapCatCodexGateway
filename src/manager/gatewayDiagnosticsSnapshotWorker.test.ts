import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { captureGatewayDiagnosticsWorkerInput } from "./gatewayDiagnosticsSnapshot.js";
import { buildIsolatedGatewayDiagnosticsSnapshot } from "./gatewayDiagnosticsSnapshotWorker.js";
import { roleInfoPayload } from "./roleInfoPayload.js";
import { RuntimeRegistry, type GatewayRuntime } from "./runtimeRegistry.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

test("diagnostics child receives persona content and replaces it between jobs", () => {
  const previousMode = process.env.RABIROUTE_MANAGER_READ_PROCESS;
  process.env.RABIROUTE_MANAGER_READ_PROCESS = "1";
  try {
    const root = path.resolve("diagnostics-fixture");
    const rolesRoot = path.join(root, "data", "roles");
    const registry = new RuntimeRegistry();
    registry.set({ id: "route-a", gatewayPort: 8791, agentRoleId: "Rabi", rolesDir: rolesRoot });
    const presentations: RouteCatalogPersonaPresentation[] = [{
      rolesRoot, roleId: "Rabi", isPersona: true, displayName: "Rabi",
      avatarConfigured: true, avatarVersion: "1-2", speech: { voiceReady: false },
      files: [{ fileName: "persona.md", exists: true, title: "Rabi",
        content: "# Rabi\n\nOriginal persona.", contentTruncated: false }]
    }];
    const input = captureGatewayDiagnosticsWorkerInput(registry.values(), () => undefined, presentations);
    presentations.splice(0);
    let installed: readonly RouteCatalogPersonaPresentation[] = [];
    const context = {
      reset: (personas: readonly RouteCatalogPersonaPresentation[]) => { installed = personas; },
      install: () => undefined,
      runtimes: () => registry.values(),
      diagnostics: (runtime: GatewayRuntime) => roleInfoPayload(root, runtime.definition, {
        personaPresentations: installed
      }),
      summary: (runtime: GatewayRuntime) => roleInfoPayload(root, runtime.definition, {
        includeContents: false, personaPresentations: installed
      })
    };
    const result = buildIsolatedGatewayDiagnosticsSnapshot(input, context);
    assert.equal(result.diagnostics[0].selectedRoleContent, "# Rabi\n\nOriginal persona.");
    assert.equal(result.diagnostics[0].selectedRoleError, "");
    const options = result.diagnostics[0].options as Record<string, unknown>[];
    assert.equal(options.length, 1);
    assert.equal(options[0].avatarUrl, "/api/roles/Rabi/avatar?v=1-2");
    assert.equal(result.summary[0].selectedRoleTitle, "Rabi");
    assert.equal("selectedRoleContent" in result.summary[0], false);
    const next = buildIsolatedGatewayDiagnosticsSnapshot({ ...input, personaPresentations: [] }, context);
    assert.deepEqual(next.diagnostics[0].options, []);
    assert.equal(next.diagnostics[0].selectedRoleContent, "");
  } finally {
    if (previousMode === undefined) delete process.env.RABIROUTE_MANAGER_READ_PROCESS;
    else process.env.RABIROUTE_MANAGER_READ_PROCESS = previousMode;
  }
});
