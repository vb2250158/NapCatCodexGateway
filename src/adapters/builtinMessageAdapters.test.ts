import assert from "node:assert/strict";
import test from "node:test";
import { builtinMessageAdapterDefinitions } from "./builtinMessageAdapters.js";

test("built-in Message Adapter manifests include only Gateway-owned adapters", () => {
  const manifests = builtinMessageAdapterDefinitions().map((definition) => definition.manifest);
  assert.deepEqual(manifests.find((manifest) => manifest.type === "fennenote"), {
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  });
  assert.equal(manifests.some((manifest) => manifest.type === "xiaoai"), false);
  assert.deepEqual(manifests.find((manifest) => manifest.type === "rabilink"), {
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  });
  const registeredTypes = new Set<string>(manifests.map((manifest) => manifest.type));
  for (const type of ["wearable", "remoteAgent", "speech", "rolePanel", "disabled"] as const) {
    assert.equal(registeredTypes.has(type), false, `${type} must not be registered as a Gateway adapter`);
  }
});
