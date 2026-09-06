import assert from "node:assert/strict";
import test from "node:test";
import { speechModelManagementClient, SpeechModelManagementRequestError } from "../src/speech/speechModelManagementClient";

const settings = { revision: 2, configuredModelRoot: null, effectiveModelRoot: "default-root", defaultModelRoot: "default-root", source: "default" as const };
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });

test("directory settings read preserves backend ownership and revision", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "/api/speech/model-management/settings");
      assert.equal(init?.method, undefined);
      return ok(settings);
    };
    assert.deepEqual(await speechModelManagementClient.directorySettings(), settings);
  } finally { globalThis.fetch = original; }
});

test("directory patch reads current lifecycle identity and forwards the expected revision", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      if (input === "/meta") return new Response(JSON.stringify({ applicationGenerationId: "generation", managerInstanceId: "manager" }));
      assert.equal(init?.method, "PATCH");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-rabiroute-expected-application-generation-id"), "generation");
      assert.equal(headers.get("x-rabiroute-expected-manager-instance-id"), "manager");
      assert.deepEqual(JSON.parse(String(init?.body)), { modelRoot: null, expectedRevision: 2 });
      return ok(settings);
    };
    await speechModelManagementClient.updateDirectorySettings({ modelRoot: null, expectedRevision: 2 });
    assert.deepEqual(calls, ["/meta", "/api/speech/model-management/settings"]);
  } finally { globalThis.fetch = original; }
});

test("local-only denial and busy or revision conflicts preserve HTTP status", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [403, 409, 412]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ code: status, message: "unavailable" }), { status });
      await assert.rejects(speechModelManagementClient.directorySettings(), error => error instanceof SpeechModelManagementRequestError && error.status === status);
    }
  } finally { globalThis.fetch = original; }
});

test("missing lifecycle identity blocks directory writes", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("{}"); };
    await assert.rejects(speechModelManagementClient.updateDirectorySettings({ modelRoot: null, expectedRevision: 2 }), /lifecycle identity/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
