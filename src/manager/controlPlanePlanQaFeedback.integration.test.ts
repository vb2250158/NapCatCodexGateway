import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPlanStoragePackage } from "../planStorageRepository.js";
import { createPlan } from "../roleKnowledge.js";
import { storageInventoryRevisionToken } from "../shared/storageRevision.js";
import { handlePersonaPluginApi } from "./controlPlaneRoutes.js";
import { RoleStorageApplication, RoleStorageApplicationError } from "./roleStorageApplication.js";

function createTestRoleStorage(t: test.TestContext, prefix: string) {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const roleDir = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  const identity = {
    applicationGenerationId: `${prefix}generation`,
    managerInstanceId: `${prefix}manager`
  };
  const application = new RoleStorageApplication({
    rolesRoot,
    ...identity,
    currentIdentity: () => identity
  });
  t.after(async () => {
    await application.stop();
    fs.rmSync(rolesRoot, { recursive: true, force: true });
  });
  return { application, roleDir, roleStorageApplication: () => application };
}

function planRevision(roleDir: string, planId: string): string {
  return storageInventoryRevisionToken(readPlanStoragePackage(roleDir, planId, "active").inventoryHash);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test Manager port."));
      resolve(address.port);
    });
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (await check()) return;
    } catch (error) {
      if (!(error instanceof RoleStorageApplicationError) || error.code !== "busy") throw error;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for plan feedback post-commit state.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("the feedback route ignores Agent guidance summaries but consumes explicit user QA verdicts", async (t) => {
  const { application, roleDir, roleStorageApplication } = createTestRoleStorage(t, "rabi-control-plane-qa-feedback-");
  createPlan(roleDir, {
    id: "plan-route-qa-verdict",
    title: "验证 QA 回传入口",
    focus: "QA 回传",
    status: "等待 QA",
    currentStepId: "verify-route",
    steps: [{ id: "verify-route", title: "QA 验收", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000008",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir, roleStorageApplication })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${port}/api/roles/Rabi/plans/plan-route-qa-verdict/feedback`;
  const postFeedback = async (body: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `feedback-test:${String(body.feedbackId)}`,
        "if-match": planRevision(roleDir, "plan-route-qa-verdict")
      },
      body: JSON.stringify({ notifyAgent: true, ...body })
    });
    const result = await response.json() as Record<string, any>;
    assert.equal(response.status, 202, JSON.stringify(result));
    return result;
  };

  const ignored = await postFeedback({
    feedbackId: "route-agent-guidance",
    kind: "guidance_response",
    text: "定向测试 matched=10 passed=10 failed=0。",
    author: "agent",
    source: "agent"
  });
  assert.equal(ignored.data.qaHandling, undefined);
  assert.equal((await application.queries.planFeedback("Rabi", "plan-route-qa-verdict"))?.plan.status, "等待 QA");
  const saved = await postFeedback({
    feedbackId: "route-user-qa-save-only",
    stepId: "verify-route",
    text: "QA 明确通过，本轮未再复现。",
    author: "user",
    source: "webgui",
    notifyAgent: false
  });
  assert.equal(saved.data.deliveryStatus, "record_only");
  assert.equal(saved.data.postCommit, undefined);
  await new Promise(resolve => setImmediate(resolve));
  const savedReadback = await fetch(endpoint).then(response => response.json()) as Record<string, any>;
  const savedRecord = savedReadback.data.records.find((record: any) => record.id === saved.data.id);
  assert.equal(savedRecord.deliveryStatus, "record_only");
  assert.equal(savedRecord.qaHandling, undefined);
  assert.equal((await application.queries.planFeedback("Rabi", "plan-route-qa-verdict"))?.plan.status, "等待 QA");
  const passed = await postFeedback({
    feedbackId: "route-user-qa-pass",
    stepId: "verify-route",
    text: "QA 明确通过，本轮未再复现。",
    author: "user",
    source: "webgui"
  });
  assert.equal(passed.data.postCommit.status, "pending");
  await waitUntil(async () => {
    const record = (await application.queries.planFeedback("Rabi", "plan-route-qa-verdict"))?.records
      .find((item) => item.id === "route-user-qa-pass");
    return record?.postCommit?.status === "completed";
  });
  const completedProjection = await application.queries.planFeedback("Rabi", "plan-route-qa-verdict");
  const consumed = completedProjection?.records.find((item) => item.id === "route-user-qa-pass");
  assert.equal(consumed?.qaHandling?.outcome, "passed");
  assert.equal(completedProjection?.plan.status, "完成");
});

test("the feedback route commits concurrent attachment retries as one durable record", async (t) => {
  const { application, roleDir, roleStorageApplication } = createTestRoleStorage(t, "rabi-control-plane-feedback-transaction-");
  createPlan(roleDir, {
    id: "plan-route-feedback-transaction",
    title: "验证反馈原子事务",
    focus: "反馈原子事务",
    status: "分析中",
    currentStepId: "verify-transaction",
    steps: [{ id: "verify-transaction", title: "事务验收", status: "进行中" }],
    keywords: ["反馈", "事务"]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir, roleStorageApplication })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${port}/api/roles/Rabi/plans/plan-route-feedback-transaction/feedback`;
  const body = {
    feedbackId: "route-feedback-transaction",
    kind: "guidance",
    text: "请保留这份事务证据。",
    author: "user",
    source: "webgui",
    notifyAgent: false,
    attachments: [{
      kind: "file",
      name: "transaction-proof.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("one durable attachment", "utf8").toString("base64")
    }]
  };
  const expectedRevision = planRevision(roleDir, "plan-route-feedback-transaction");
  const post = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "feedback-test:route-feedback-transaction",
        "if-match": expectedRevision
      },
      body: JSON.stringify(body)
    });
    const result = await response.json() as Record<string, any>;
    return { status: response.status, result };
  };

  const nonCanonical = await fetch(
    `http://127.0.0.1:${port}/api/roles/Rabi/plans/%20plan-route-feedback-transaction/feedback`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "feedback-test:route-feedback-transaction-invalid",
        "if-match": planRevision(roleDir, "plan-route-feedback-transaction")
      },
      body: JSON.stringify(body)
    }
  );
  const nonCanonicalResult = await nonCanonical.json() as Record<string, any>;
  assert.equal(nonCanonical.status, 400);
  assert.match(String(nonCanonicalResult.message || ""), /trimmed and Unicode NFC-normalized/);

  const concurrent = await Promise.all([post(), post()]);
  for (const response of concurrent) {
    if (response.status === 202) {
      assert.equal(response.result.data.id, body.feedbackId);
      continue;
    }
    assert.equal(response.status, 503, JSON.stringify(response.result));
    assert.equal(response.result.state, "indeterminate", JSON.stringify(response.result));
    assert.equal(response.result.retry, "same_idempotency_key_only", JSON.stringify(response.result));
    assert.equal(response.result.idempotencyKey, "feedback-test:route-feedback-transaction");
  }
  const records = (await application.queries.planFeedback("Rabi", "plan-route-feedback-transaction"))?.records ?? [];
  assert.equal(records.length, 1);
  assert.equal(records[0].attachments.length, 1);
  assert.equal(
    fs.readFileSync(records[0].attachments[0].path, "utf8"),
    "one durable attachment"
  );
});

test("the feedback route returns 202 after durable commit even when QA post-commit fails", async (t) => {
  const { application, roleDir, roleStorageApplication } = createTestRoleStorage(t, "rabi-control-plane-feedback-post-commit-");
  createPlan(roleDir, {
    id: "plan-route-feedback-post-commit",
    title: "验证反馈提交边界",
    focus: "反馈持久化后再执行 QA 副作用",
    status: "等待 QA",
    currentStepId: "verify-post-commit",
    steps: [{ id: "verify-post-commit", title: "QA 验收", status: "进行中" }],
    keywords: ["反馈", "QA"]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir, roleStorageApplication })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await fetch(
    `http://127.0.0.1:${port}/api/roles/Rabi/plans/plan-route-feedback-post-commit/feedback`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "feedback-test:route-feedback-post-commit",
        "if-match": planRevision(roleDir, "plan-route-feedback-post-commit")
      },
      body: JSON.stringify({
        feedbackId: "route-feedback-post-commit",
        stepId: "verify-post-commit",
        text: "问题仍存在。复现步骤：重新执行操作。修复前结果不正确，修复后实际结果仍不正确。",
        author: "user",
        source: "webgui",
        notifyAgent: true
      })
    }
  );
  const result = await response.json() as Record<string, any>;
  assert.equal(response.status, 202, JSON.stringify(result));
  assert.equal(result.data.id, "route-feedback-post-commit");

  await waitUntil(async () => {
    const record = (await application.queries.planFeedback("Rabi", "plan-route-feedback-post-commit"))?.records[0];
    return record?.postCommit?.status === "failed";
  });
  const records = (await application.queries.planFeedback("Rabi", "plan-route-feedback-post-commit"))?.records ?? [];
  assert.equal(records.length, 1);
  assert.equal((records[0] as any).postCommit.status, "failed");
  assert.equal(records[0].qaHandling?.status, "dispatch_failed");
});
