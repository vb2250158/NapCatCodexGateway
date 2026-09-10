import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { LanAgentRegistry } from "./lanAgentRegistry.js";

type ConnectedClient = {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  waitFor: (type: string) => Promise<Record<string, unknown>>;
};

test("instance identity survives restart and management replies stay on their authenticated connection", async () => {
  const statePath = temporaryStatePath();
  const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" });
  const port = await listen(server);
  let alpha: ConnectedClient | undefined;
  let beta: ConnectedClient | undefined;
  try {
    const agents = [{ agentId: "first", name: "Agent", provider: "codex-desktop", enabled: true }];
    alpha = await connectNode(port, "fixture", "alpha", agents);
    beta = await connectNode(port, "fixture", "beta", agents);
    assert.equal(registry.listInstances()[0]?.local, true);
    assert.equal(registry.listInstances()[1]?.agents[0]?.agentId, "first");
    const pending = registry.manageAgent("alpha", "scan", {});
    const request = await alpha.waitFor("manageAgent");
    beta.socket.send(JSON.stringify({ type: "managementResult", requestId: request.requestId, result: "wrong-owner" }));
    alpha.socket.send(JSON.stringify({ type: "managementResult", requestId: request.requestId, result: "right-owner" }));
    assert.equal(await pending, "right-owner");
    const restored = new LanAgentRegistry({ statePath });
    assert.equal(restored.localInstanceId, registry.localInstanceId);
    restored.close();
    const disconnected = registry.manageAgent("alpha", "scan", {});
    alpha.socket.close();
    await assert.rejects(disconnected, /disconnected/);
  } finally {
    alpha?.socket.close(); beta?.socket.close(); registry.close();
    await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

function temporaryStatePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-lan-agent-registry-"));
  return path.join(root, "state.json");
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("test server did not return a TCP port"));
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function connectNode(port: number, token: string, nodeId: string, agents?: Array<Record<string, unknown>>): Promise<ConnectedClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/lan-agent/connect`);
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, Array<(message: Record<string, unknown>) => void>>();
  const waitFor = (type: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const existing = messages.find(message => message.type === type);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2_000);
    const queued = waiters.get(type) ?? [];
    queued.push(message => { clearTimeout(timer); resolve(message); });
    waiters.set(type, queued);
  });
  socket.on("message", value => {
    const message = JSON.parse(value.toString()) as Record<string, unknown>;
    messages.push(message);
    const pending = waiters.get(String(message.type ?? ""));
    waiters.delete(String(message.type ?? ""));
    pending?.forEach(resolve => resolve(message));
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "authenticate", token }));
  await waitFor("authenticated");
  socket.send(JSON.stringify({ type: "hello", node: { nodeId, version: "0.1.0", platform: "win32-x64", agentTypes: ["codex-desktop"], allowedWorkspaces: ["C:/work"], agents } }));
  await waitFor("connected");
  return { socket, messages, waitFor };
}

test("LAN Agent registry authenticates, persists state, routes updates, and protects task ownership", async () => {
  const statePath = temporaryStatePath();
  const root = path.dirname(statePath);
  const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer((_request, response) => response.end("ok"));
  const detach = registry.attach(server, { enabled: () => true, getToken: () => "lan-token" });
  const port = await listen(server);
  let alpha: ConnectedClient | undefined;
  let beta: ConnectedClient | undefined;
  try {
    const invalid = new WebSocket(`ws://127.0.0.1:${port}/api/lan-agent/connect`);
    await new Promise<void>((resolve, reject) => { invalid.once("open", resolve); invalid.once("error", reject); });
    invalid.send(JSON.stringify({ type: "authenticate", token: "wrong-token" }));
    await new Promise<void>(resolve => invalid.once("close", () => resolve()));

    alpha = await connectNode(port, "lan-token", "node-alpha");
    assert.deepEqual(registry.listNodes().map(node => node.nodeId), ["node-alpha"]);
    const update = registry.requestUpdate("node-alpha", "0.2.0");
    assert.equal(update.updateState, "requested");
    assert.equal((await alpha.waitFor("updateAvailable")).version, "0.2.0");

    const task = registry.assignTask({ nodeId: "node-alpha", targetAgent: "codex-desktop", message: "Inspect the workspace", cwd: "C:/work", idempotencyKey: "task-key" });
    assert.equal(task.status, "delivered");
    assert.throws(() => registry.assignTask({ nodeId: "node-alpha", targetAgent: "codex-desktop", message: "Different payload", cwd: "C:/work", idempotencyKey: "task-key" }), /different message/);
    await assert.rejects(registry.waitForTaskAcceptance(task.taskId, 5), /not confirmed/);
    assert.equal(((await alpha.waitFor("assignTask")).task as { taskId?: unknown } | undefined)?.taskId, task.taskId);
    alpha.socket.send(JSON.stringify({ type: "ackTask", taskId: task.taskId }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listTasks()[0]?.status, "acknowledged");
    const accepted = registry.waitForTaskAcceptance(task.taskId);
    alpha.socket.send(JSON.stringify({ type: "progress", taskId: task.taskId, summary: "owner accepted" }));
    assert.equal((await accepted).status, "progress");

    beta = await connectNode(port, "lan-token", "node-beta");
    beta.socket.send(JSON.stringify({ type: "taskResult", taskId: task.taskId, status: "completed", summary: "not allowed" }));
    await beta.waitFor("error");
    assert.equal(registry.listTasks().find(item => item.taskId === task.taskId)?.status, "progress");

    alpha.socket.send(JSON.stringify({ type: "taskResult", taskId: task.taskId, status: "completed", summary: "done" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listTasks().find(item => item.taskId === task.taskId)?.status, "completed");
    alpha.socket.send(JSON.stringify({ type: "updateResult", status: "updating" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listNodes().find(node => node.nodeId === "node-alpha")?.updateState, "updating");
    alpha.socket.send(JSON.stringify({ type: "updateResult", status: "updated" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listNodes().find(node => node.nodeId === "node-alpha")?.updateState, "updated");

    const restored = new LanAgentRegistry({ statePath });
    assert.equal(restored.listNodes().find(node => node.nodeId === "node-alpha")?.connected, false);
    assert.equal(restored.listTasks().find(item => item.taskId === task.taskId)?.status, "completed");
    restored.close();
  } finally {
    alpha?.socket.close();
    beta?.socket.close();
    detach();
    registry.close();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
