import assert from "node:assert/strict";
import test from "node:test";
import { buildLanAgentBootstrapPrompt } from "../src/lanAgentBootstrap";

test("LAN bootstrap includes current endpoint, trust pin, both hosts and automatic binding", () => {
  const prompt = buildLanAgentBootstrapPrompt({ managerUrl: "http://192.168.1.20:23456/#/lan-agents", token: "fixture-only", publicKeySha256: "a".repeat(64) });
  assert.match(prompt, /http:\/\/192\.168\.1\.20:23456\/api\/lan-agent\/releases\/manifest/);
  assert.match(prompt, /RABI_AGENT_DSH_SESSION_ID/);
  assert.match(prompt, /RABI_AGENT_CODEX_THREAD_ID/);
  assert.match(prompt, /SPKI DER/);
  assert.match(prompt, /不等待它退出/);
  assert.doesNotMatch(prompt, /1728|8790/);
});

test("LAN bootstrap rejects unusable addresses and missing trust material", () => {
  const input = { managerUrl: "http://127.0.0.1:1234", token: "fixture-only", publicKeySha256: "a".repeat(64) };
  assert.throws(() => buildLanAgentBootstrapPrompt(input), /局域网地址/);
  assert.throws(() => buildLanAgentBootstrapPrompt({ ...input, managerUrl: "https://manager.test", publicKeySha256: "" }), /指纹/);
});
