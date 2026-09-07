import assert from "node:assert/strict";
import test from "node:test";
import { buildRoleKnowledgeContextView, planMemoryApiHint } from "./roleKnowledgeContext.js";

test("AgentPacket plan hints explain shared guidance and approval feedback workflows", () => {
  const hints = planMemoryApiHint("Rabi Test").join("\n");

  assert.match(hints, /\/api\/roles\/Rabi%20Test\/plans\/\{planId\}\/feedback/);
  assert.match(hints, /source=qq/);
  assert.match(hints, /kind=guidance/);
  assert.match(hints, /guidance_response/);
  assert.match(hints, /kind=approval_response/);
  assert.match(hints, /调整后续步骤/);
  assert.match(hints, /不直接推进步骤/);
  assert.match(hints, /另行 PATCH/);
  assert.match(hints, /approvalRequest/);
  assert.match(hints, /files\/commands\/changes/);
  assert.match(hints, /完整命令/);
  assert.match(hints, /isBlocked 是兼容投影，不要手写/);
  assert.match(hints, /approver/);
  assert.match(hints, /recommendation/);
  assert.match(hints, /sourceMessageId/);
  assert.match(hints, /现有信息无法形成可审批的具体方案/);
  assert.match(hints, /缺失信息影响原因、改法、范围或验收合同/);
  assert.match(hints, /暂未复现、疑似历史已修复、缺目标包、等待 QA 或等待是否关闭都不是 roles\.informationNeeded/);
  assert.match(hints, /roles\.waitingPackage/);
  assert.match(hints, /roles\.waitingQa/);
  assert.match(hints, /roles\.closed/);
  assert.match(hints, /roles\.paused/);
  assert.match(hints, /plan\.status 只保存/);
  assert.match(hints, /planWorkflow\.roles/);
  assert.match(hints, /GET \/api\/roles\/Rabi%20Test\/plan-statuses/);
  assert.match(hints, /计划 POST\/PATCH 的 attachments/);
  assert.match(hints, /name\/mimeType\/contentBase64/);
  assert.match(hints, /GET \/api\/personas\?addressable=true/);
  assert.match(hints, /sourceRouteId/);
  assert.match(hints, /sourceCapability/);
  assert.match(hints, /deliveryId/);
  assert.match(hints, /personaMessageMaxHops/);
  assert.match(hints, /Idempotency-Key/);
  assert.match(hints, /If-Match/);
  assert.match(hints, /强 ETag/);
  assert.match(hints, /有界超时/);
  assert.match(hints, /applicationGenerationId/);
  assert.match(hints, /managerInstanceId/);
  assert.match(hints, /成功响应.*Idempotency-Key.*强 ETag/);
  assert.match(hints, /503[^\n]*同一个 Idempotency-Key/);
  assert.match(hints, /412[^\n]*废弃[^\n]*重新 GET[^\n]*新[^\n]*Idempotency-Key/);
});

test("focused AgentPacket hints keep plan attachment discovery available", () => {
  const view = buildRoleKnowledgeContextView("Rabi Test", {
    contextInjection: { mode: "focused" },
    requiredReadItems: [],
    matchedSkills: [],
    activePlans: [],
    activeSkills: [],
    recentMemories: [],
    matchedItems: []
  } as unknown as Parameters<typeof buildRoleKnowledgeContextView>[1]);
  const hints = view.apiHintLines.join("\n");

    assert.match(hints, /待审批计划/);
    assert.match(hints, /计划 attachments/);
    assert.match(hints, /图片、视频预览/);
    assert.match(hints, /plan\.status 只保存/);
    assert.match(hints, /无法形成可审批具体方案/);
    assert.match(hints, /roles\.analysis、roles\.informationNeeded、roles\.approval、roles\.execution/);
    assert.match(hints, /roles\.waitingPackage/);
    assert.match(hints, /roles\.waitingQa/);
    assert.match(hints, /roles\.closed/);
    assert.match(hints, /POST \/api\/personas\/\{personaId\}\/messages/);
    assert.match(hints, /Idempotency-Key/);
    assert.match(hints, /有界超时/);
    assert.match(hints, /applicationGenerationId/);
    assert.match(hints, /managerInstanceId/);
    assert.match(hints, /412[^\n]*废弃[^\n]*新[^\n]*Idempotency-Key/);
  });
