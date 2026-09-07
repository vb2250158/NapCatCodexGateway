import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from './index.mjs';
import { requestHook } from './manager-client.mjs';

test('DSH forwards lifecycle identity and obeys Manager decisions without local policies', async () => {
  const handlers = new Map();
  const requests = [];
  const injected = [];
  const agent = { id: 'session-one', inject: value => injected.push(value) };
  apply({ on: (event, handler) => handlers.set(event, handler) }, {}, async request => {
    requests.push(request);
    return request.eventName === 'PreToolUse'
      ? { toolDecision: { permissionDecision: 'deny', reason: 'persona policy' } }
      : { additionalContext: 'manager context' };
  });
  handlers.get('agent/session-start')({ agent, source: 'resume' });
  const messages = [{ content: [{ type: 'text', text: 'hello' }] }];
  const decision = await handlers.get('agent/pre-step')({ agent, messages, turn: 3 }, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 2);
  assert.deepEqual(requests.slice(0, 2).map(item => item.eventName), ['SessionStart', 'UserPromptSubmit']);
  let executed = false;
  const denied = await handlers.get('tools/pre-execute')({ agent, name: 'pwsh', arguments: {}, callId: 'call-1' }, async () => { executed = true; });
  assert.equal(denied.kind, 'deny');
  assert.equal(executed, false);
  handlers.get('session/event')({ id: agent.id }, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'done' }] } } });
  await handlers.get('agent/turn-stopping')({ agent, turn: 3 });
  assert.equal(requests.at(-1).lastAssistantMessage, 'done');
  assert.equal(requests.at(-1).sessionId, agent.id);
});

test('DSH keeps independent execution when Manager is absent', async () => {
  const handlers = new Map();
  const status = apply({ on: (event, handler) => handlers.set(event, handler) }, {}, async () => { throw new Error('offline'); });
  const result = await handlers.get('tools/pre-execute')({ agent: { id: 'unbound' } }, async () => ({ kind: 'allow' }));
  assert.equal(result.kind, 'allow');
  assert.equal(status.lastError, 'offline');
});

test('DSH rejects a stale Host generation before forwarding events', async () => {
  const urls = [];
  await assert.rejects(requestHook({}, {
    env: { RABIROUTE_HOST_EXE: 'host' },
    execute: async () => ({ stdout: JSON.stringify({ managerBaseUrl: 'http://localhost:12345', applicationGenerationId: 'new', managerInstanceId: 'one' }) }),
    fetch: async url => { urls.push(url); return { ok: true, json: async () => ({ health: { state: 'healthy', requiredReady: true }, applicationGenerationId: 'old' }) }; }
  }), /generation/);
  assert.equal(urls.length, 1);
});
