import assert from "node:assert/strict";
import test from "node:test";
import { webReleaseQuery } from "../src/webRelease.js";

test("module requests use only the validated release pinned by the root document", context => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  });
  Reflect.deleteProperty(globalThis, "document");
  assert.equal(webReleaseQuery(), "");
  for (const value of [null, "", "legacy", "../other", "a".repeat(64)]) {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { getAttribute: () => value } } });
    assert.equal(webReleaseQuery(), value === "a".repeat(64) ? `?webRelease=${value}` : "");
  }
});
