import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { approvalSubmissionErrorMessage } from "../src/approvalFeedbackUi";
import {
  FALLBACK_PLAN_PRESENTATION_PALETTE,
  formatPlanDirectorySortLabel,
  formatPlanDirectorySortLabelTitle,
  formatPlanRelativeTime,
  formatPlanVideoDuration,
  normalizePlanPresentationPalette,
  planCardStyle,
  planDescriptionForDisplay,
  planDirectorySortPalette,
  planStatusDescriptionForDisplay,
  planStatusLabelForDisplay,
  planStatusStyle,
  planTitleForDirectory,
  plansForKnowledgeView
} from "../src/planPresentationStyles";
import type { RolePlan } from "../src/types";

test("plan styles pass through the Manager-owned palette", () => {
  const palette = normalizePlanPresentationPalette({
    accent: "#EF6C52",
    background: "#FFF1ED",
    foreground: "#B42318"
  });

  assert.deepEqual(palette, {
    accent: "#ef6c52",
    background: "#fff1ed",
    foreground: "#b42318"
  });
  assert.deepEqual(planCardStyle(palette), { "--plan-tone": "#ef6c52" });
  assert.deepEqual(planStatusStyle(palette), {
    "--plan-status-accent": "#ef6c52",
    backgroundColor: "#fff1ed",
    color: "#b42318"
  });
});

test("WebGUI renders the Manager QA label and purple palette without reclassifying the status", () => {
  const qaPlan = {
    status: "等待 QA",
    presentation: {
      status: "等待 QA",
      label: "等待 QA 验收",
      labelEn: "Awaiting QA acceptance",
      description: "目标包已确认，正在等待 QA 验收结论。",
      descriptionEn: "The target package is confirmed and awaiting QA acceptance.",
      palette: { accent: "#7c3aed", background: "#f3e8ff", foreground: "#6d28d9" },
      importance: undefined,
      urgency: undefined
    }
  } as unknown as RolePlan;

  assert.equal(planStatusLabelForDisplay(qaPlan.presentation), "等待 QA 验收");
  assert.equal(planStatusLabelForDisplay(qaPlan.presentation, "en"), "Awaiting QA acceptance");
  assert.deepEqual(planDirectorySortPalette(qaPlan, "status"), qaPlan.presentation.palette);
  assert.equal(qaPlan.status, "等待 QA");
});

test("invalid or missing Manager colors use one neutral compatibility palette", () => {
  assert.deepEqual(
    normalizePlanPresentationPalette({ accent: "red", background: "", foreground: "#123" }),
    FALLBACK_PLAN_PRESENTATION_PALETTE
  );
});

test("knowledge categories consume Manager view membership instead of raw status", () => {
  const plan = {
    id: "plan-1",
    status: "自定义状态",
    presentation: { views: ["current", "plans"] }
  } as unknown as RolePlan;

  assert.deepEqual(plansForKnowledgeView([plan], "plans"), [plan]);
  assert.deepEqual(plansForKnowledgeView([plan], "archived"), []);
  assert.deepEqual(plansForKnowledgeView([plan], "recent_memory"), []);
});

test("plan descriptions hide legacy title fallbacks but preserve a real focus", () => {
  assert.equal(planDescriptionForDisplay({ title: "Plan title", focus: "Plan title" }), "");
  assert.equal(planDescriptionForDisplay({ title: "Plan title", focus: "  One focused delivery objective  " }), "One focused delivery objective");
});

test("plan directory titles hide repeated leading bracket tags without changing ordinary titles", () => {
  assert.equal(planTitleForDirectory("[ExampleProject][Bug] 赛季目标 - 培养道具"), "赛季目标 - 培养道具");
  assert.equal(planTitleForDirectory("  [ExampleProject] [查询] 月卡配置  "), "月卡配置");
  assert.equal(planTitleForDirectory("普通计划标题"), "普通计划标题");
  assert.equal(planTitleForDirectory("[ExampleProject]"), "[ExampleProject]");
});

test("plan directory relative time uses one largest suitable unit", () => {
  const now = Date.UTC(2026, 7, 7, 12, 0, 0);
  assert.equal(formatPlanRelativeTime(new Date(now - 20_000).toISOString(), now), "刚刚");
  assert.equal(formatPlanRelativeTime(new Date(now - 8 * 60_000).toISOString(), now), "8分钟前");
  assert.equal(formatPlanRelativeTime(new Date(now - 3 * 60 * 60_000).toISOString(), now), "3小时前");
  assert.equal(formatPlanRelativeTime(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), now), "2天前");
  assert.equal(formatPlanRelativeTime(new Date(now - 65 * 24 * 60 * 60_000).toISOString(), now), "2个月前");
  assert.equal(formatPlanRelativeTime(new Date(now - 800 * 24 * 60 * 60_000).toISOString(), now), "2年前");
  assert.equal(formatPlanRelativeTime(new Date(now - 60 * 60_000).toISOString(), now, "en"), "1 hr ago");
});

test("plan directory shows one trailing label for the active sort mode", () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);
  const plan = {
    status: "design-review-key",
    updatedAt: new Date(now - 4 * 60 * 60_000).toISOString(),
    presentation: {
      status: "design-review-key",
      label: "设计复核",
      labelEn: "Design review",
      description: "等待设计负责人复核",
      descriptionEn: "Waiting for design owner review",
      tone: "custom-review",
      statusLevel: 17,
      acceptsGuidance: true,
      views: ["current", "plans"],
      palette: { accent: "#ef6c52", background: "#fff1ed", foreground: "#b42318" },
      importance: {
        level: 0,
        label: "最高",
        labelEn: "Highest",
        palette: { accent: "#dc2626", background: "#fef2f2", foreground: "#b91c1c" }
      },
      urgency: {
        level: 1,
        label: "高",
        labelEn: "High",
        palette: { accent: "#f97316", background: "#fff1ed", foreground: "#c2410c" }
      }
    }
  } as RolePlan;

  assert.equal(formatPlanDirectorySortLabel(plan, "status", now), "设计复核");
  assert.equal(formatPlanDirectorySortLabel(plan, "status", now, "en"), "Design review");
  assert.equal(planStatusLabelForDisplay(plan.presentation), "设计复核");
  assert.equal(planStatusDescriptionForDisplay(plan.presentation, "en"), "Waiting for design owner review");
  assert.equal(formatPlanDirectorySortLabel(plan, "updated", now), "4小时前");
  assert.equal(formatPlanDirectorySortLabel(plan, "importance", now), "最高");
  assert.equal(formatPlanDirectorySortLabel(plan, "urgency", now), "高");
  assert.equal(formatPlanDirectorySortLabel({ ...plan, presentation: { ...plan.presentation, importance: undefined } }, "importance", now), "未设置");
  assert.equal(formatPlanDirectorySortLabel({ ...plan, presentation: { ...plan.presentation, urgency: undefined } }, "urgency", now), "未设置");
  assert.equal(formatPlanDirectorySortLabelTitle(plan, "importance", now), "重要程度：最高");
  assert.equal(formatPlanDirectorySortLabelTitle(plan, "urgency", now, "en"), "Urgency: High");
  assert.deepEqual(planDirectorySortPalette(plan, "status"), plan.presentation.palette);
  assert.deepEqual(planDirectorySortPalette(plan, "importance"), plan.presentation.importance?.palette);
  assert.deepEqual(planDirectorySortPalette(plan, "urgency"), plan.presentation.urgency?.palette);
  assert.deepEqual(planDirectorySortPalette(plan, "updated"), {
    accent: "#0891b2",
    background: "#ecfeff",
    foreground: "#0e7490"
  });
});

test("plan video durations use compact player-style timestamps", () => {
  assert.equal(formatPlanVideoDuration(undefined), "--:--");
  assert.equal(formatPlanVideoDuration(Number.NaN), "--:--");
  assert.equal(formatPlanVideoDuration(13.73), "0:14");
  assert.equal(formatPlanVideoDuration(125), "2:05");
  assert.equal(formatPlanVideoDuration(3723), "1:02:03");
});

test("approval submission turns browser fetch failures into an actionable retry message", () => {
  const message = approvalSubmissionErrorMessage(new TypeError("Failed to fetch"));
  assert.match(message, /无法连接 Manager/);
  assert.match(message, /计划反馈内容已保留/);
  assert.equal(approvalSubmissionErrorMessage(new Error("Plan step not found")), "原因：Plan step not found");
});

test("knowledge page avoids full-list refresh after feedback and keeps details animation-free", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const composer = fs.readFileSync(path.join(root, "src", "components", "PlanFeedbackComposer.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const client = fs.readFileSync(path.join(root, "src", "roleKnowledgeClient.ts"), "utf8");
  const submitBody = page.match(/async function sendApprovalSuggestion[\s\S]*?\n}\n<\/script>/)?.[0] || "";

  assert.match(page, /loadPlanFeedback/);
  assert.doesNotMatch(submitBody, /await refreshKnowledge\(\)/);
  assert.doesNotMatch(page, /<v-expand-transition>/);
  assert.match(page, /class="knowledge-plan-focus"/);
  assert.match(page, /<section v-if="isApprovalStep\(plan, step\)" class="knowledge-approval-panel"/);
  assert.doesNotMatch(page, /<section v-if="plan\.presentation\.approval\.state !== 'none'" class="knowledge-approval-panel"/);
  assert.match(styles, /\.knowledge-step \.knowledge-approval-panel\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  assert.match(composer, /@keydown="handleKeydown"/);
  assert.match(composer, /function handleKeydown[\s\S]*?if \(!plainEnter\(event\)\) return;[\s\S]*?emit\("submit"\)/);
  assert.match(composer, /event\.isComposing[\s\S]*?event\.shiftKey/);
  assert.match(page, /:submit-disabled="!canSubmitApproval\(plan\)"/);
  assert.match(page, /function approvalFeedbackBaseAvailable[\s\S]*?Boolean\(approval\.stepId\) && approval\.enabled/);
  assert.doesNotMatch(page, /approval\.state === "incomplete" \|\| approval\.enabled/);
  assert.match(page, /function canEditApprovalFeedback[\s\S]*?approvalFeedbackBaseAvailable\(plan\)/);
  assert.match(page, /:disabled="!canEditApprovalFeedback\(plan\)"/);
  assert.match(page, /function canSubmitApproval[\s\S]*?return canEditApprovalFeedback\(plan\)/);
  const editPolicyBody = page.match(/function canEditApprovalFeedback[\s\S]*?\n}/)?.[0] || "";
  const submitPolicyBody = page.match(/function canSubmitApproval[\s\S]*?\n}/)?.[0] || "";
  const addAttachmentBody = page.match(/function addApprovalFiles[\s\S]*?\n}/)?.[0] || "";
  const openAttachmentPickerBody = composer.match(/function openFilePicker[\s\S]*?\n}/)?.[0] || "";
  const removeAttachmentBody = page.match(/function removeApprovalAttachment[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(editPolicyBody, /approvalDeliveryPending/);
  assert.match(submitPolicyBody, /approvalDeliveryPending/);
  assert.doesNotMatch(addAttachmentBody, /approvalDeliveryPending/);
  assert.doesNotMatch(openAttachmentPickerBody, /approvalDeliveryPending/);
  assert.doesNotMatch(removeAttachmentBody, /approvalDeliveryPending/);
  assert.match(page, /上一条意见已记录，正在通知 Agent；你可以继续编辑下一条，通知完成后即可提交。/);
  assert.match(page, /当前没有可投递的 Route；仍可“提交”保存，绑定 Route 后才能“提交并投递”。/);
  assert.match(page, /class="knowledge-approval-compose-status"/);
  assert.match(page, /审批资料不完整，补齐前禁止输入或提交审批意见。/);
  assert.doesNotMatch(page, /该意见不会被视为批准/);
  assert.match(page, /提交并投递/);
  assert.match(page, /submit-record-only-label/);
  assert.match(page, /localizedPlanError\(submitError, isEnglish\.value\)/);
  assert.match(page, /const feedbackId = feedbackRequestId\(plan\.id, signature\)/);
  assert.match(page, /方案尚未写完整/);
  assert.match(page, /方案还缺少以下内容/);
  assert.match(page, /审批人 \/ 责任人/);
  assert.match(page, /推荐方案/);
  assert.match(page, /必要备选/);
  assert.match(page, /<ul class="knowledge-approval-alternatives">/);
  assert.match(styles, /\.knowledge-approval-alternatives\s*\{[\s\S]*?padding:\s*0[\s\S]*?list-style:\s*none/);
  assert.match(styles, /\.knowledge-approval-alternatives > li::before\s*\{[\s\S]*?position:\s*absolute[\s\S]*?left:\s*2px/);
  assert.match(styles, /\.knowledge-approval-contract-grid > section\s*\{[\s\S]*?min-width:\s*0/);
  assert.match(styles, /\.knowledge-approval-contract-grid ul\s*\{[\s\S]*?min-width:\s*0/);
  assert.match(styles, /\.knowledge-approval-contract-grid li\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(page, /附件与预览/);
  assert.match(page, /最近请求时间/);
  assert.match(page, /来源消息 \/ Feedback/);
  assert.match(page, /当前回执状态/);
  assert.match(composer, /@paste="handlePaste"/);
  assert.match(composer, /function handlePaste[\s\S]*?\.filter\(\(item\) => item\.kind === "file"\)[\s\S]*?emit\("add-files", \{ files, fromClipboard: true \}\)/);
  assert.match(page, /function clipboardAttachmentName[\s\S]*?if \(kind === "image"\)[\s\S]*?return file\.name/);
  assert.match(page, /function approvalRecordsForDisplay[\s\S]*?feedback\.kind === "approval_suggestion"[\s\S]*?\.reverse\(\)/);
  assert.match(page, /v-for="feedback in approvalRecordsForDisplay\(plan\)"/);
  assert.match(page, /class="knowledge-approval-record"/);
  assert.match(page, /function togglePlan\(plan: RolePlan\): void \{[\s\S]*?if \(expanded\) \{[\s\S]*?void refreshPlanApproval\(plan\.id\);[\s\S]*?\}/);
  assert.match(page, /class="knowledge-work-history"[\s\S]*?togglePlanWorkHistory\(plan\)/);
  assert.match(page, /loadPlanHistory[\s\S]*?function refreshPlanHistory/);
  assert.match(page, /guidanceRecordsForDisplay\(plan\)[\s\S]*?approvalRecordsForDisplay\(plan\)[\s\S]*?步骤审批合同[\s\S]*?计划版本记录/);
  assert.match(page, /function planApprovalContractsForHistory[\s\S]*?step\.approvalRequest/);
  assert.match(styles, /\.knowledge-work-history\s*\{[\s\S]*?border:/);
  assert.doesNotMatch(page, /v-if="plan\.approval\.latest" class="knowledge-approval-latest"/);
  assert.match(client, /latest:\s*data\.latest \|\| records\[0\],[\s\S]*?\r?\n\s*records\r?\n/);
  assert.match(styles, /\.knowledge-approval-history\s*\{[\s\S]*?display:\s*grid[\s\S]*?gap:\s*8px/);
  assert.match(styles, /\.knowledge-approval-record\s*\{[\s\S]*?display:\s*grid[\s\S]*?border-left:\s*3px solid/);
  assert.match(composer, /@click="openFilePicker"/);
  assert.match(page, /contentBase64: await attachmentContentBase64\(attachment\.file\)/);
  assert.match(page, /submittedApprovalAttachments\.set\(plan\.id, takeApprovalAttachments\(plan\.id\)\)/);
  assert.match(page, /function resetApprovalAttachmentState\(\): void\s*\{/);
  assert.match(page, /onBeforeUnmount\(\(\) => \{[\s\S]*?resetApprovalAttachmentState\(\)/);
  assert.match(styles, /\.knowledge-approval-attachment\s*\{[\s\S]*?grid-template-columns:\s*46px minmax\(0, 1fr\) 28px/);
  assert.match(page, /function planAcceptsGuidance[\s\S]*?plan\.presentation\.acceptsGuidance === true[\s\S]*?plan\.presentation\.approval\.state === "none"/);
  assert.doesNotMatch(page, /plan\.status ===/);
  assert.doesNotMatch(page, /t\(plan\.status\)/);
  assert.match(page, /<section v-if="planAcceptsGuidance\(plan\)" class="knowledge-approval-panel" data-state="guidance">/);
  assert.match(page, /引导属于整个计划，不绑定某个步骤/);
  assert.match(page, /调整后续步骤/);
  assert.match(page, /:composer-id="`guidance-\$\{plan\.id\}`"[\s\S]*?@submit="sendPlanGuidance\(plan\)"/);
  assert.match(page, /async function sendPlanGuidance[\s\S]*?sendPlanFeedback\(plan, "guidance", notifyAgent\)/);
  assert.match(page, /const stepId = guidance \? undefined : plan\.presentation\.approval\.stepId/);
  assert.match(page, /const attachments = await approvalAttachmentUploads\(plan\.id\)/);
  assert.match(page, /const planAttachmentIds = referencedPlanAttachmentIds\(text, allApprovalMentionCandidates\(plan\)\)/);
  assert.match(page, /submittedApprovalAttachments\.set\(plan\.id, takeApprovalAttachments\(plan\.id\)\)/);
  assert.doesNotMatch(page, /guidance \? \[\] : await approvalAttachmentUploads/);
  assert.match(page, /<section v-if="planAcceptsGuidance\(plan\)"[\s\S]*?<PlanFeedbackComposer[\s\S]*?:attachments="approvalAttachmentsFor\(plan\.id\)"[\s\S]*?@add-files="addApprovalFiles\(plan\.id, \$event\.files, \$event\.fromClipboard\)"/);
  assert.match(page, /v-for="feedback in guidanceRecordsForDisplay\(plan\)"[\s\S]*?feedback\.attachments[\s\S]*?feedback\.planAttachments/);
  assert.match(client, /kind: input\.kind/);
  assert.match(page, /提交并投递/);
});

test("plan guidance and approval reuse one feedback composer", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const composer = fs.readFileSync(path.join(root, "src", "components", "PlanFeedbackComposer.vue"), "utf8");

  assert.equal((page.match(/<PlanFeedbackComposer\b/g) || []).length, 2);
  assert.match(page, /<PlanFeedbackComposer[\s\S]*?:composer-id="`guidance-\$\{plan\.id\}`"/);
  assert.match(page, /<PlanFeedbackComposer[\s\S]*?:composer-id="`approval-\$\{plan\.id\}`"/);
  assert.doesNotMatch(page, /<v-textarea[\s\S]*?handleGuidanceEnter/);
  assert.match(composer, /findPlanAttachmentMentionQuery/);
  assert.match(composer, /insertPlanAttachmentMention/);
  assert.match(composer, /@keydown="handleKeydown"/);
  assert.match(composer, /@paste="handlePaste"/);
  assert.match(composer, /type="file"[\s\S]*?@change="handleFileSelection"/);
  assert.match(composer, /emit\("submit"\)/);
});

test("plan views expose a floating directory outside the plan browser", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(page, /class="knowledge-browser-layout"/);
  assert.match(page, /class="knowledge-plan-directory"/);
  assert.match(page, /class="knowledge-plan-directory"[\s\S]*?<\/nav>\s*<div[\s\S]*?role="separator"[\s\S]*?<v-card class="app-card knowledge-browser"/);
  assert.match(page, /v-for="plan in visiblePlansForView"/);
  assert.match(page, /const renderedPlansForView = computed\(\(\) => knowledgeRenderWindow\(\s*visiblePlansForView\.value/);
  assert.match(page, /function currentPlanPageFilter[\s\S]*?sort:\s*planListSortMode\.value[\s\S]*?statuses[\s\S]*?tags/);
  assert.match(page, /v-model="planListDialogOpen"[\s\S]*?max-width="1180"[\s\S]*?scrollable[\s\S]*?aria-labelledby="plan-list-dialog-title"/);
  assert.doesNotMatch(page, /<v-menu v-model="planList/);
  assert.match(page, /@click="openPlanListDialog"/);
  assert.match(page, /icon="mdi-close"[\s\S]*?@click="planListDialogOpen = false"/);
  assert.match(page, /class="knowledge-plan-list-control-layout"/);
  assert.match(page, /class="knowledge-plan-list-panel knowledge-plan-list-sort-panel"/);
  assert.match(page, /class="knowledge-plan-list-panel knowledge-plan-list-filter-panel"/);
  assert.match(page, /class="knowledge-plan-list-panel knowledge-plan-list-filter-panel knowledge-plan-list-tag-panel"/);
  assert.match(page, /:aria-pressed="planListDraftSortMode === 'updated'"/);
  assert.match(page, /:aria-pressed="planListDraftSortMode === 'importance'"/);
  assert.match(page, /:aria-pressed="planListDraftSortMode === 'urgency'"/);
  assert.match(page, /class="knowledge-plan-directory-count"/);
  assert.match(page, /class="knowledge-plan-directory-sort-trigger"/);
  assert.match(page, /@click="planListDraftSortMode = 'status'"/);
  assert.match(page, /@click="planListDraftSortMode = 'updated'"/);
  assert.match(page, /@click="planListDraftSortMode = 'importance'"/);
  assert.match(page, /@click="planListDraftSortMode = 'urgency'"/);
  assert.match(page, /function applyPlanListDialog[\s\S]*?planListSortMode\.value = planListDraftSortMode\.value[\s\S]*?planListHiddenStatuses\.value = \[\.\.\.planListDraftHiddenStatuses\.value\][\s\S]*?planListSelectedTags\.value = \[\.\.\.planListDraftSelectedTags\.value\]/);
  assert.match(page, /@click="applyPlanListDialog"/);
  assert.match(page, /@change="togglePlanListStatus\(option\.status\)"/);
  assert.match(page, /@change="togglePlanListTag\(option\.tag\)"/);
  assert.match(page, /planListResultTotal\.value = result\.total/);
  assert.match(page, /@click="jumpToPlan\(\$event, plan\)"/);
  assert.match(page, /new IntersectionObserver\(scheduleActiveDirectoryPlanSync/);
  assert.match(page, /window\.requestAnimationFrame\(syncActiveDirectoryPlan\)/);
  assert.match(page, /window\.addEventListener\("scroll", scheduleActiveDirectoryPlanSync, \{ passive: true \}\)/);
  assert.match(page, /function holdDirectoryJumpTarget\(planId: string, smooth: boolean\)/);
  assert.match(page, /if \(directoryJumpTargetId\) return;/);
  assert.match(page, /window\.addEventListener\("scroll", waitForDirectoryJumpSettle, \{ passive: true \}\)/);
  assert.match(page, /async function focusPlanCardAfterDirectoryJump/);
  assert.match(page, /holdDirectoryJumpTarget\(planId, !reduceMotion\)/);
  assert.match(page, /ref="planDirectoryList"/);
  assert.match(page, /:data-plan-directory-id="plan\.id"/);
  assert.match(page, /:id="planCardDomId\(plan\.id\)"/);
  assert.match(page, /tabindex="-1"/);
  assert.doesNotMatch(page, /knowledge-plan-directory-index/);
  assert.doesNotMatch(page, /class="knowledge-plan-directory-status"/);
  assert.doesNotMatch(page, /class="knowledge-plan-directory-working"/);
  assert.match(page, /class="knowledge-plan-directory-sort-label"/);
  assert.match(page, /:style="planDirectorySortStyle\(plan\)"/);
  assert.match(page, /formatPlanDirectorySortLabel\([\s\S]*?plan,[\s\S]*?planListSortMode\.value/);
  assert.match(page, /<v-chip[^>]*>\{\{ planStatusLabel\(plan\) \}\}<\/v-chip>/);
  assert.match(page, /planTitleForDirectory\(plan\.title\)/);
  assert.doesNotMatch(page, /knowledge-plan-toc|jumpToPlanStep|planStepDomId|activePlanSteps/);
  assert.match(styles, /\.knowledge-browser-layout\.has-plan-directory\s*\{[\s\S]*?grid-template-columns:\s*var\(--plan-directory-width, 360px\) 1px minmax\(0, 1fr\)/);
  assert.match(styles, /\.knowledge-plan-directory\s*\{[\s\S]*?position:\s*sticky[\s\S]*?max-height:\s*calc\(100dvh - 104px\)/);
  assert.match(styles, /\.knowledge-plan-directory-list\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /\.knowledge-plan-directory-list\s*\{[\s\S]*?overflow-x:\s*hidden[\s\S]*?overflow-y:\s*auto/);
  assert.doesNotMatch(styles, /\.knowledge-plan-cards\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.v-card\.knowledge-browser\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(styles, /\.knowledge-toolbar\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*var\(--v-layout-top, 64px\)[\s\S]*?z-index:\s*6/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?scroll-margin-top:\s*152px/);
  assert.match(styles, /\.knowledge-plan-directory-link\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /\.knowledge-plan-directory-link\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.doesNotMatch(styles, /\.knowledge-plan-directory-status\s*\{/);
  assert.match(styles, /\.knowledge-plan-directory-count\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums/);
  assert.match(styles, /\.knowledge-plan-list-dialog\s*\{[\s\S]*?max-height:\s*min\(840px/);
  assert.match(styles, /\.knowledge-plan-list-control-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(360px, \.86fr\) minmax\(480px, 1\.14fr\)/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.knowledge-plan-list-control-layout\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.doesNotMatch(page, /class="knowledge-plan-directory-updated"/);
  assert.match(styles, /\.knowledge-plan-directory-sort-label\s*\{[\s\S]*?flex:\s*0 0 auto[\s\S]*?white-space:\s*nowrap/);
  assert.match(page, /@mouseenter="setPlanDirectoryMarquee\(\$event, true\)"/);
  assert.match(page, /@focus="setPlanDirectoryMarquee\(\$event, true\)"/);
  assert.match(page, /class="knowledge-plan-directory-title"/);
  assert.match(page, /const distance = Math\.ceil\(title\.scrollWidth - title\.clientWidth\)/);
  assert.match(page, /if \(distance <= 1\) return;/);
  assert.match(styles, /\.knowledge-plan-directory-title\[data-marquee="active"\] > span\s*\{[\s\S]*?animation:\s*knowledge-plan-directory-marquee[^;]*\slinear\s/);
  assert.match(styles, /@keyframes knowledge-plan-directory-marquee/);
  assert.doesNotMatch(styles, /knowledge-plan-directory-index|knowledge-plan-directory-copy small/);
  assert.match(styles, /@media \(max-width:\s*960px\)[\s\S]*?\.knowledge-browser-layout\.has-plan-directory\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width:\s*960px\)[\s\S]*?\.knowledge-toolbar\s*\{[\s\S]*?position:\s*static/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.knowledge-plan-directory-link/);
});

test("plan cards use isolated work-item framing and a three-level execution hierarchy", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(page, /v-for="plan in renderedPlansForView"/);
  assert.doesNotMatch(page, /planSequence\(/);
  assert.doesNotMatch(page, /class="knowledge-plan-sequence"/);
  assert.doesNotMatch(styles, /\.knowledge-plan-sequence/);
  assert.match(page, /class="knowledge-plan-current"/);
  assert.match(page, /class="knowledge-plan-current-copy"/);
  assert.match(page, /class="knowledge-plan-current-heading"/);
  assert.match(page, /v-if="currentStep\(plan\)\?\.detail" class="knowledge-plan-current-detail"/);
  assert.match(page, /class="knowledge-plan-timing-item"/);
  assert.match(page, /class="knowledge-steps-head"/);
  assert.match(page, /currentStepPosition\(plan\)/);
  assert.match(styles, /\.knowledge-plan-cards\s*\{[\s\S]*?gap:\s*18px[\s\S]*?background:\s*var\(--rr-subtle\)/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?border-radius:\s*14px[\s\S]*?box-shadow:/);
  assert.match(styles, /\.knowledge-plan-summary\s*\{[\s\S]*?grid-template-columns:\s*minmax\(280px, 1fr\) max-content/);
  assert.match(styles, /\.knowledge-plan-current-copy\s*\{[\s\S]*?display:\s*grid[\s\S]*?gap:/);
  assert.match(styles, /\.knowledge-plan-current-heading\s*\{[\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/);
  assert.match(styles, /\.knowledge-plan-current-detail\s*\{[\s\S]*?white-space:\s*normal[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.knowledge-plan-timing-item\s*\{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center/);
  assert.match(styles, /\.knowledge-steps\s*\{[\s\S]*?border-radius:\s*12px[\s\S]*?background:/);
  assert.match(styles, /@media \(max-width:\s*720px\)[\s\S]*?\.knowledge-plan-head\s*\{[\s\S]*?margin:\s*-12px -12px 0/);
  assert.match(styles, /@media \(max-width:\s*720px\)[\s\S]*?\.knowledge-plan-timing\s*\{[\s\S]*?grid-auto-flow:\s*row/);
});

test("plan cards render managed attachments and preview 16:9 image and video media", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8") + fs.readFileSync(path.join(root, "src/components/PlanAttachmentGallery.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(page, /v-if="planDetailsLoaded\[plan\.id\] && plan\.attachments\.length" class="knowledge-plan-attachments"/);
  assert.match(page, /import \{ managerEventSource, managerResourceUrl \} from "\.\.\/managerApi"/);
  assert.match(page, /function planAttachmentUrl[\s\S]*?return managerResourceUrl\(/);
  assert.match(page, /planAttachmentUrl\(plan\.id, attachment\.id\)/);
  assert.match(page, /loading="lazy"/);
  assert.match(page, /item\.kind === 'image' \|\| item\.kind === 'video'/);
  assert.match(page, /@click="openPlanMediaPreview\(plan, attachment\)"/);
  assert.match(page, /function planVideoThumbnailUrl[\s\S]*?#t=0\.001/);
  assert.match(page, /<video\b[^>]*v-if="attachment\.kind === 'video'"/);
  assert.match(page, /@loadedmetadata="capturePlanVideoDuration\(plan\.id, attachment\.id, \$event\); setPlanMediaLoadState\(plan\.id, attachment\.id, 'loaded'\)"/);
  assert.match(page, /class="knowledge-plan-attachment-loading"/);
  assert.match(page, /附件加载中/);
  assert.match(page, /class="knowledge-plan-video-play"/);
  assert.match(page, /class="knowledge-plan-video-duration"/);
  assert.match(page, /displayedPlanVideoDuration\(plan\.id, attachment\.id\)/);
  assert.match(page, /class="knowledge-plan-media-preview"/);
  assert.match(page, /planAttachmentPreview\?\.kind === 'video'[\s\S]*?controls/);
  assert.match(page, /:model-value="Boolean\(planAttachmentPreview\)"/);
  assert.match(styles, /\.knowledge-plan-attachment\.image\s*\{[\s\S]*?cursor:\s*zoom-in/);
  assert.match(styles, /\.knowledge-plan-attachment\.media\s*\{[\s\S]*?flex:\s*0 1 208px[\s\S]*?width:\s*208px[\s\S]*?max-width:\s*100%/);
  assert.match(styles, /\.knowledge-plan-attachment-visual\s*\{[\s\S]*?aspect-ratio:\s*16 \/ 9/);
  assert.match(styles, /\.knowledge-plan-attachment-loading\s*\{[\s\S]*?animation:\s*knowledge-attachment-loading/);
  assert.match(styles, /\.knowledge-plan-attachment-visual > video\s*\{[\s\S]*?object-fit:\s*contain/);
  assert.match(styles, /\.knowledge-plan-video-play\s*\{[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*2[\s\S]*?pointer-events:\s*none/);
  assert.match(styles, /\.knowledge-plan-video-duration\s*\{[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*2[\s\S]*?font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(styles, /:hover\s+\.knowledge-plan-video-duration[^}]*\{[^}]*display:\s*(?:none|block)/);
  assert.match(styles, /\.knowledge-plan-media-preview-stage\s*\{[\s\S]*?max-height:\s*78vh/);
  assert.match(styles, /\.knowledge-plan-media-preview-stage video\s*\{[\s\S]*?background:\s*#000/);
  assert.match(page, /isPlanMarkdownAttachment\(item\.name, item\.mimeType\)/);
  assert.match(page, /@click="openPlanMarkdownPreview\(plan, attachment\)"/);
  assert.match(page, /const preview = reactive\(\{[\s\S]*?loading: true[\s\S]*?\}\);/);
  assert.match(page, /PLAN_MARKDOWN_TEASER_READ_BYTES/);
  assert.match(page, /planMarkdownPreviewExcerpt\(source\)/);
  assert.match(page, /function responseTextWithinLimit[\s\S]*?responseTextByByteLimit\(response, byteLimit, false, overflowMessage\)/);
  assert.match(page, /responseTextWithinLimit\([\s\S]*?PLAN_MARKDOWN_PREVIEW_MAX_BYTES/);
  assert.match(page, /class="knowledge-plan-attachment media markdown"/);
  assert.match(page, /class="knowledge-plan-attachment-visual knowledge-plan-markdown-visual"/);
  assert.match(page, /planMarkdownTeaser\(plan\.id, attachment\.id\)\.text/);
  assert.match(page, /v-html="planMarkdownPreview\.html"/);
  assert.match(page, /t\("下载原文件"\)/);
  assert.match(styles, /\.knowledge-plan-markdown-visual\s*\{[\s\S]*?padding:\s*9px[\s\S]*?background:/);
  assert.match(styles, /\.knowledge-plan-markdown-paper\s*\{[\s\S]*?height:\s*100%[\s\S]*?border-top:\s*3px solid var\(--rr-accent-strong\)/);
  assert.match(styles, /\.knowledge-plan-markdown-teaser\s*\{[\s\S]*?-webkit-line-clamp:\s*4/);
  assert.match(styles, /\.knowledge-plan-markdown-document\s*\{[\s\S]*?border-top:\s*4px solid var\(--rr-accent-strong\)[\s\S]*?background:\s*var\(--rr-surface\)/);
  assert.match(styles, /html\[data-rabiroute-theme="dark"\] :is\([\s\S]*?\.knowledge-plan-directory-sort-label,[\s\S]*?\.knowledge-plan-status[\s\S]*?var\(--plan-status-accent\)/);
  assert.match(page, /class="knowledge-plan-status"/);
  assert.match(styles, /\.knowledge-plan-markdown-document pre\s*\{[\s\S]*?overflow:\s*auto/);
});

test("step blocker styling follows the structured approval contract", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");

  assert.match(page, /function stepIsBlocked[\s\S]*?plan\.presentation\.approval\.state === "ready"/);
  assert.match(page, /blocked: stepIsBlocked\(plan, step\)/);
  assert.match(page, /stepIsBlocked\(plan, step\) && step\.blockedBy/);
  assert.match(page, /stepIsBlocked\(plan, step\) \? "已阻塞" : step\.completedAt \? "已完成" : "进行中"/);
  assert.doesNotMatch(page, /step\.status/);
  assert.doesNotMatch(page, /plan\.presentation\.tone !== ['"]paused['"] && step\.blockedBy/);
});

test("plan steps derive current and completed presentation without a stored status", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");

  assert.match(page, /step\.id === plan\.currentStepId && step\.startedAt[\s\S]*?开始时间[\s\S]*?formatDate\(step\.startedAt\)/);
  assert.match(page, /v-else-if="step\.completedAt"[\s\S]*?完成时间[\s\S]*?formatDate\(step\.completedAt\)/);
  assert.doesNotMatch(page, /未开始/);
});


test("feedback actions keep both submit buttons in one compact group", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const composer = fs.readFileSync(path.join(root, "src/components/PlanFeedbackComposer.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");
  const group = composer.match(/<div class="knowledge-approval-action-buttons">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.equal((group.match(/<v-btn/g) ?? []).length, 2);
  assert.match(group, /submit-record-only/);
  assert.match(group, /emit\('submit'\)/);
  assert.match(styles, /\.knowledge-approval-action-buttons\s*\{[^}]*display: flex;[^}]*gap: 8px;/);
  assert.doesNotMatch(styles, /\.knowledge-approval-actions \.v-btn\s*\{[^}]*width: 100%;/);
});


test("approval review prioritizes decisions and shared previews without hiding validation guards", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src/pages/RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");
  const app = fs.readFileSync(path.join(root, "src/App.vue"), "utf8");
  assert.equal((page.match(/<PlanAttachmentGallery/g) ?? []).length, 2);
  assert.match(page, /class="knowledge-approval-evidence">[\s\S]*?<PlanAttachmentGallery/);
  assert.ok(page.indexOf('class="knowledge-approval-evidence"') < page.indexOf("完整方案与审批记录"));
  assert.match(page, /<details v-if="plan.presentation.approval.contract.files.length"/);
  assert.match(page, /<details v-if="plan.presentation.approval.contract.commands.length"/);
  assert.match(page, /<section v-if="plan.presentation.approval.contract.changes.length"/);
  assert.doesNotMatch(page, /无执行命令；如实际|无文件改动；如实际|当前计划没有审批附件；/);
  assert.match(page, /v-if="plan.presentation.approval.missing.length"/);
  assert.match(page, /:submit-disabled="!canSubmitApproval\(plan\)"/);
  assert.match(app, /'navigation-collapsed': !drawer/);
  assert.match(styles, /\.navigation-collapsed \.knowledge-page\s*\{[^}]*max-width: min\(1880px, 100%\);/);
});
