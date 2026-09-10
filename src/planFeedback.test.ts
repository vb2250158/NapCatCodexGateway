import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPlanFeedback,
  commitPlanFeedback,
  createPlanFeedbackRecord,
  listPlanFeedback,
  planFeedbackAttachmentsEqual,
  planFeedbackPlanAttachmentsEqual,
  planFeedbackSummary,
  recoverPlanFeedbackStoreTransactions,
  resolvePlanFeedbackPlanAttachments,
  updatePlanFeedbackDelivery
} from "./planFeedback.js";
import {
  planFeedbackAttachmentDirectory,
  planFeedbackFile,
  planJsonFile,
  type PlanStorageBucket
} from "./planStorageLayout.js";

function canonicalPlanFixture(bucket: PlanStorageBucket = "active") {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-feedback-transaction-"));
  const planId = `plan-${bucket}`;
  const planFile = planJsonFile(roleDir, planId, bucket);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, `${JSON.stringify({
    id: planId,
    status: bucket === "archive" ? "关闭" : "执行中",
    archiveStatus: bucket === "archive" ? "已归档" : "未归档"
  })}\n`, "utf8");
  return { roleDir, planId, bucket };
}

function transactionCandidate(planId: string) {
  return createPlanFeedbackRecord({
    id: "feedback-transaction",
    roleId: "Rabi",
    planId,
    planTitle: "Transaction plan",
    stepId: "review",
    stepTitle: "Review",
    source: "webgui",
    text: "Keep the attachment set and feedback row together."
  });
}

function transactionUploads() {
  return [
    {
      name: "first.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("first attachment", "utf8").toString("base64")
    },
    {
      name: "second.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("second attachment", "utf8").toString("base64")
    }
  ];
}

function findTransactionManifest(root: string): string {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === "manifest.json") return candidate;
    }
  }
  throw new Error("transaction manifest not found");
}

test("plan feedback records approval context and collapses delivery updates", () => {
  const { roleDir, planId } = canonicalPlanFixture();
  const pending = createPlanFeedbackRecord({
    id: "request-1",
    roleId: "Rabi",
    planId,
    planTitle: "Approval plan",
    stepId: "review",
    stepTitle: "等待审批",
    gatewayId: "route-1",
    source: "webgui",
    text: "建议补充回归范围后继续。",
    planAttachments: [{
      id: "preview",
      kind: "image",
      name: "preview.png",
      path: path.join(roleDir, "plans", "attachments", "plan-1", "preview.png"),
      size: 12,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }]
  });
  appendPlanFeedback(roleDir, pending);
  updatePlanFeedbackDelivery(roleDir, pending, "failed", "temporary delivery failure");
  updatePlanFeedbackDelivery(roleDir, pending, "pending");
  updatePlanFeedbackDelivery(roleDir, pending, "delivered");

  const records = listPlanFeedback(roleDir, planId);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.deliveryStatus, "delivered");
  assert.equal(records[0]?.stepId, "review");
  assert.equal(records[0]?.planAttachments[0]?.id, "preview");
  assert.deepEqual(planFeedbackSummary(roleDir, planId), { count: 1, latest: records[0] });
});

test("agent feedback is record-only and text length is validated", () => {
  const record = createPlanFeedbackRecord({
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Approval plan",
    author: "agent",
    source: "agent",
    kind: "approval_response",
    text: "已按建议补充验证范围。"
  });
  assert.equal(record.deliveryStatus, "record_only");
  assert.throws(() => createPlanFeedbackRecord({
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Approval plan",
    text: "a".repeat(2_001)
  }), /exceeds 2000/);
});

test("plan guidance remains plan-level and uses a distinct response kind", () => {
  const guidance = createPlanFeedbackRecord({
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Running plan",
    kind: "guidance",
    text: "先收窄范围，再调整后续步骤。"
  });
  const response = createPlanFeedbackRecord({
    roleId: "Rabi",
    planId: "plan-1",
    planTitle: "Running plan",
    kind: "guidance_response",
    author: "agent",
    source: "agent",
    text: "已调整计划范围和后续步骤。"
  });

  assert.equal(guidance.kind, "guidance");
  assert.equal(guidance.stepId, undefined);
  assert.equal(guidance.deliveryStatus, "pending");
  assert.equal(response.kind, "guidance_response");
  assert.equal(response.deliveryStatus, "record_only");
});

test("plan feedback compares mentioned plan attachments by stable metadata", () => {
  const reference = [{
    id: "report",
    kind: "file" as const,
    name: "report.md",
    path: "C:/private/role/plans/attachments/plan/report.md",
    size: 9,
    mimeType: "text/markdown",
    sha256: "b".repeat(64)
  }];
  assert.equal(planFeedbackPlanAttachmentsEqual(reference, reference), true);
  assert.equal(planFeedbackPlanAttachmentsEqual(reference, [{ ...reference[0]!, sha256: "c".repeat(64) }]), false);
  assert.deepEqual(resolvePlanFeedbackPlanAttachments(reference, ["report"]), reference);
  assert.deepEqual(resolvePlanFeedbackPlanAttachments([], ["report"], reference), reference);
  assert.throws(() => resolvePlanFeedbackPlanAttachments(reference, ["missing"]), /not found/);
  assert.throws(() => resolvePlanFeedbackPlanAttachments(reference, ["report", "report"]), /unique/);
});

test("plan feedback attachments are private, bounded, and idempotent", () => {
  const { roleDir, planId } = canonicalPlanFixture();
  const contentBase64 = Buffer.from("image bytes", "utf8").toString("base64");
  const candidate = createPlanFeedbackRecord({
    id: "request-with-file",
    roleId: "Rabi",
    planId,
    planTitle: "Attachment plan",
    text: "Keep this private attachment with its feedback row."
  });
  const first = commitPlanFeedback(roleDir, candidate, [{
    name: "approval.png",
    mimeType: "image/png",
    contentBase64
  }]).record.attachments;
  const retry = commitPlanFeedback(roleDir, candidate, [{
    name: "approval.png",
    mimeType: "image/png",
    contentBase64
  }]).record.attachments;

  assert.equal(first.length, 1);
  assert.equal(first[0]?.kind, "image");
  assert.equal(fs.readFileSync(first[0]!.path, "utf8"), "image bytes");
  assert.equal(planFeedbackAttachmentsEqual(first, retry), true);
  assert.throws(() => commitPlanFeedback(roleDir, candidate, [{
    name: "approval.png",
    mimeType: "image/png",
    contentBase64: Buffer.from("different", "utf8").toString("base64")
  }]), /different content|different semantic content/);
});

test("plan feedback commit uses the canonical archive package for both ledger and attachments", () => {
  const { roleDir, planId, bucket } = canonicalPlanFixture("archive");
  const result = commitPlanFeedback(roleDir, transactionCandidate(planId), transactionUploads());

  assert.equal(result.created, true);
  assert.equal(fs.existsSync(planFeedbackFile(roleDir, planId, "active")), false);
  assert.equal(fs.existsSync(planFeedbackFile(roleDir, planId, bucket)), true);
  assert.equal(
    path.dirname(result.record.attachments[0]!.path),
    planFeedbackAttachmentDirectory(roleDir, planId, result.record.id, bucket)
  );
  assert.equal(fs.readFileSync(result.record.attachments[0]!.path, "utf8"), "first attachment");
});

test("plan feedback commit recovers staged, published, and ledger fault boundaries without duplicates", () => {
  const cases = [
    { point: "attachment_staged" as const, attachmentIndex: 0, finalVisible: false, ledgerVisible: false },
    { point: "attachments_committed" as const, finalVisible: true, ledgerVisible: false },
    { point: "feedback_committed" as const, finalVisible: true, ledgerVisible: true }
  ];

  for (const scenario of cases) {
    const { roleDir, planId, bucket } = canonicalPlanFixture();
    const candidate = transactionCandidate(planId);
    const attachmentDir = planFeedbackAttachmentDirectory(roleDir, planId, candidate.id, bucket);
    const ledger = planFeedbackFile(roleDir, planId, bucket);
    assert.throws(() => commitPlanFeedback(roleDir, candidate, transactionUploads(), {
      faultInjector(point, attachmentIndex) {
        if (point === scenario.point && attachmentIndex === scenario.attachmentIndex) {
          throw new Error(`injected fault at ${point}`);
        }
      }
    }), /injected fault/);

    assert.equal(fs.existsSync(attachmentDir), scenario.finalVisible, scenario.point);
    assert.equal(fs.existsSync(ledger), scenario.ledgerVisible, scenario.point);
    if (fs.existsSync(attachmentDir)) {
      assert.equal(fs.readdirSync(attachmentDir).length, 2, scenario.point);
    }

    const recovered = commitPlanFeedback(roleDir, transactionCandidate(planId), transactionUploads());
    assert.equal(recovered.created, !scenario.ledgerVisible, scenario.point);
    assert.deepEqual(
      fs.readdirSync(attachmentDir).sort(),
      ["01-first.txt", "02-second.txt"]
    );
    assert.equal(fs.readFileSync(path.join(attachmentDir, "01-first.txt"), "utf8"), "first attachment");
    assert.equal(fs.readFileSync(path.join(attachmentDir, "02-second.txt"), "utf8"), "second attachment");
    assert.equal(
      fs.readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).length,
      1,
      scenario.point
    );
    assert.equal(fs.existsSync(path.join(path.dirname(attachmentDir), ".transactions")), false);

    const retry = commitPlanFeedback(roleDir, transactionCandidate(planId), transactionUploads());
    assert.equal(retry.created, false, scenario.point);
    assert.equal(fs.readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).length, 1);
  }
});

test("plan feedback writes its manifest only after a complete payload and can restage a partial pre-manifest payload", () => {
  const { roleDir, planId, bucket } = canonicalPlanFixture();
  const candidate = transactionCandidate(planId);
  let payloadWrites = 0;
  assert.throws(() => commitPlanFeedback(roleDir, candidate, transactionUploads(), {
    repositoryTransaction: {
      hooks: {
        afterPayloadWrite() {
          payloadWrites += 1;
          if (payloadWrites === 1) throw new Error("simulated exit during payload staging");
        }
      }
    }
  }), /simulated exit during payload staging/);

  assert.equal(fs.existsSync(planFeedbackFile(roleDir, planId, bucket)), false);
  assert.equal(fs.existsSync(planFeedbackAttachmentDirectory(roleDir, planId, candidate.id, bucket)), false);
  assert.deepEqual(recoverPlanFeedbackStoreTransactions(roleDir), {
    committed: 0,
    alreadyCommitted: 0,
    failures: []
  });

  const retried = commitPlanFeedback(roleDir, transactionCandidate(planId), transactionUploads());
  assert.equal(retried.created, true);
  assert.equal(listPlanFeedback(roleDir, planId).length, 1);
  assert.deepEqual(
    fs.readdirSync(planFeedbackAttachmentDirectory(roleDir, planId, candidate.id, bucket)).sort(),
    ["01-first.txt", "02-second.txt"]
  );
  assert.deepEqual(recoverPlanFeedbackStoreTransactions(roleDir).failures, []);
});

test("plan feedback startup recovery publishes the missing ledger row once", () => {
  const { roleDir, planId } = canonicalPlanFixture();
  const candidate = transactionCandidate(planId);
  assert.throws(() => commitPlanFeedback(roleDir, candidate, transactionUploads(), {
    faultInjector(point) {
      if (point === "attachments_committed") throw new Error("simulated Manager crash");
    }
  }), /simulated Manager crash/);

  const first = recoverPlanFeedbackStoreTransactions(roleDir);
  assert.equal(first.committed, 1);
  assert.deepEqual(first.failures, []);
  assert.equal(listPlanFeedback(roleDir, planId).length, 1);

  const second = recoverPlanFeedbackStoreTransactions(roleDir);
  assert.equal(second.alreadyCommitted, 1);
  assert.deepEqual(second.failures, []);
  const records = listPlanFeedback(roleDir, planId);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.attachments.length, 2);
});

test("plan feedback startup recovery binds each manifest to the scanned role directory", () => {
  const source = canonicalPlanFixture();
  const otherRole = canonicalPlanFixture();
  const candidate = transactionCandidate(source.planId);
  assert.throws(() => commitPlanFeedback(source.roleDir, candidate, transactionUploads(), {
    faultInjector(point) {
      if (point === "attachments_committed") throw new Error("simulated role binding crash");
    }
  }), /simulated role binding crash/);

  const manifestPath = findTransactionManifest(path.join(source.roleDir, "plans", "quarantine"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, roleDir: otherRole.roleDir }, null, 2)}\n`, "utf8");

  const recovered = recoverPlanFeedbackStoreTransactions(source.roleDir);
  assert.equal(recovered.committed, 0);
  assert.ok(recovered.failures.length >= 1);
  assert.equal(recovered.failures.every((failure) => /role identity mismatch/.test(failure.error)), true);
  assert.equal(listPlanFeedback(source.roleDir, source.planId).length, 0);
  assert.equal(listPlanFeedback(otherRole.roleDir, otherRole.planId).length, 0);
});

test("plan feedback transaction follows the canonical package when the plan is archived before retry", () => {
  const { roleDir, planId } = canonicalPlanFixture();
  const candidate = transactionCandidate(planId);
  assert.throws(() => commitPlanFeedback(roleDir, candidate, transactionUploads(), {
    faultInjector(point) {
      if (point === "attachments_committed") throw new Error("injected archive boundary");
    }
  }), /injected archive boundary/);

  const activeDirectory = path.dirname(planJsonFile(roleDir, planId, "active"));
  const archiveDirectory = path.dirname(planJsonFile(roleDir, planId, "archive"));
  fs.mkdirSync(path.dirname(archiveDirectory), { recursive: true });
  fs.renameSync(activeDirectory, archiveDirectory);
  fs.writeFileSync(planJsonFile(roleDir, planId, "archive"), `${JSON.stringify({
    id: planId,
    status: "关闭",
    archiveStatus: "已归档"
  })}\n`, "utf8");

  const recovered = commitPlanFeedback(roleDir, transactionCandidate(planId), transactionUploads());
  assert.equal(recovered.created, true);
  assert.equal(fs.existsSync(planFeedbackFile(roleDir, planId, "active")), false);
  assert.equal(fs.existsSync(planFeedbackFile(roleDir, planId, "archive")), true);
  assert.equal(
    path.dirname(recovered.record.attachments[0]!.path),
    planFeedbackAttachmentDirectory(roleDir, planId, recovered.record.id, "archive")
  );
  assert.equal(
    fs.readdirSync(planFeedbackAttachmentDirectory(roleDir, planId, recovered.record.id, "archive")).length,
    2
  );
});

test("plan feedback commit rejects a reused id with different content inside the plan lock", () => {
  const { roleDir, planId, bucket } = canonicalPlanFixture();
  const first = commitPlanFeedback(roleDir, transactionCandidate(planId), transactionUploads());
  const conflicting = {
    ...transactionCandidate(planId),
    text: "A different request must not reuse the transaction id."
  };

  assert.equal(first.created, true);
  assert.throws(
    () => commitPlanFeedback(roleDir, conflicting, transactionUploads()),
    /already exists with different content/
  );
  assert.equal(
    fs.readFileSync(planFeedbackFile(roleDir, planId, bucket), "utf8").split(/\r?\n/).filter(Boolean).length,
    1
  );
  assert.equal(
    fs.readdirSync(planFeedbackAttachmentDirectory(roleDir, planId, first.record.id, bucket)).length,
    2
  );
});


test("save-only user feedback has no delivery or post-commit work", () => {
  for (const kind of ["guidance", "approval_suggestion"] as const) {
    const input = { roleId: "reviewer", planId: "plan", planTitle: "Review", author: "user", source: "webgui", kind, text: "QA passed; review later" };
    const saved = createPlanFeedbackRecord({ ...input, notifyAgent: false });
    assert.equal(saved.deliveryStatus, "record_only");
    assert.equal(saved.postCommit, undefined);
    assert.equal(saved.gatewayId, undefined);
    const delivered = createPlanFeedbackRecord({ ...input, notifyAgent: true });
    assert.equal(delivered.deliveryStatus, "pending");
    assert.equal(delivered.postCommit?.status, "pending");
  }
});
