---
name: plan-task-orchestration
description: Use before any repository task governed by RabiRoute plan admission, including bug fixes, features, UI, assets, config, data, docs, prompts, skills, builds, deployments, and external writes; also use to create, deduplicate, bind, resume, audit, migrate, or complete a formal plan. Drive the unique bound task through 分析中 → 待补充信息/待审批 → 执行中 → 等待打包/等待 QA → 完成 with evidence, owner-feedback rollback, parallel work, and no duplicate dispatches. Do not use for strictly read-only investigation that will not produce or execute a change.
---

# Plan Task Orchestration

Use one RabiRoute plan as the lifecycle truth and one Codex task as that plan's execution context. Keep the mapping stable from investigation through acceptance.

## Read the current contracts

Before writing a plan or binding a task, read the relevant sections of:

- [Rabi Agent interfaces](../../docs/rabi-agent-interfaces.md) for the current Manager APIs and Codex thread bridge.
- [Plan and memory model](../../docs/plan-and-memory-model.md) for the current Plan schema, approval projection, feedback, task binding, and lifecycle rules.
- [Create RabiRoute Agent adapter](../create-rabiroute-agent-adapter/SKILL.md) when changing or diagnosing task discovery, Desktop ownership, thread creation, or delivery behavior.

Resolve the current Manager generation before every plan read or write. Installed mode obtains `managerBaseUrl`, `applicationGenerationId`, and `managerInstanceId` from `RabiRouteHost.exe --command status --json`; source mode uses only the Manager's freshly printed structured READY URL. Validate the address and identities against `/meta`, and rediscover after a restart instead of retaining the old URL. Prefer native Codex Desktop task tools for task ownership when they are available; otherwise call `POST /api/agent/threads` through the same validated Manager address.

## Handle Manager availability without blocking project work

1. Resolve the current generation endpoint before the first Manager call. A previous URL refusing connections means that URL is stale; rediscover it before classifying Manager availability.
2. Treat `401 + WEBGUI_TOKEN_REQUIRED` as an authentication case and follow the project credential rule. After current-generation discovery, treat connection refusal, timeout, DNS failure, HTTP `5xx`, an unhealthy `/meta`, or an identity mismatch as an availability failure.
3. The installed application's sole lifecycle owner is `RabiRouteHost.exe`. Do not scan ports, read retired endpoint lock files, launch Manager directly, terminate Host/Manager/tray processes, or start a second Runtime. Host owns same-generation recovery. Source mode without an injected or freshly printed READY URL also fails closed instead of guessing an endpoint.
4. Search only bounded source candidates for read-only recovery evidence: an injected or configured RabiRoute root, the documented sibling project path, and an explicit project path. Never scan arbitrary drives for a checkout.
5. If Manager remains unavailable, use direct role files only for read-only semantic deduplication and recovery. Do not write role files, create placeholder plans, or dispatch tasks through files.
6. When discovery or recovery evidence remains insufficient, use the governing project's versioned offline plan-adjustment queue before continuing authorized project work. When the project defines `RabiPlanCache` as its offline queue, create or update one validated JSON record under `RabiPlanCache/pending/`; record the full task session, intended plan change, acceptance criteria, changed SVN-relative files, validations, revisions, and remaining work. Commit the cache with the related project change. Never store credentials, player privacy, private messages, or full logs.
7. Treat the offline cache as a synchronization queue, not plan truth. Manager plan writes and task delivery remain unavailable evidence, not a business-work blocker. If the cache tool itself cannot be repaired, record that failure once and continue the authorized work.
8. When Manager returns, rediscover and validate its current generation before processing pending records oldest first. Semantically deduplicate by outcome, scope, and acceptance criteria, create or update the real plan through Manager, reread it, then mark the cache `synced` only with the real `planId` and sync session. Commit that receipt. If Manager does not return, leave the record pending and report only the actual Rabi state.

## Preserve the invariants

- Create a formal plan only for work that needs cross-turn execution, waiting, follow-up, or acceptance. Do not create one for chat or a one-turn answer.
- When a project-level policy says that any potentially mutating task requires a plan, perform plan admission before business investigation, design, implementation, or file writes while Manager is available. During a verified availability failure, follow the fallback above and continue the authorized project work. A strictly read-only task remains exempt only while it cannot produce or execute a project change.
- Give each plan one single-line `focus`, one coherent outcome, explicit acceptance criteria, and ordered `steps`.
- Bind exactly one independent business execution task to one plan. Do not bind a coordinator, reminder, or persona chat task.
- Keep `taskBinding.sessionId` as the stable task identity and `taskBinding.workspace` as the execution directory for each delivery. Treat `sessionTitle` and the task's saved default cwd as mutable metadata.
- Treat the plan as the status truth, the bound task as the execution-history truth, and optional memory as recovery context. Never let one substitute for another.
- Allow only one control-plane writer per `planId`. Reread before PATCH and verify the returned plan after writing.
- Do not bulk-create tasks for old plans. Repair a binding only when that plan becomes active, relevant, or explicitly audited.
- Keep all execution, external action, approval, privacy, and sandbox boundaries in force. This skill grants no additional authority.
- Treat plan attachments as lifecycle evidence, not approval-only decoration. Preserve the most useful available source documents, screenshots, references, generated designs, implementation previews, test evidence, and acceptance artifacts in the plan whenever they materially help understanding, decision, execution, or verification.

## Keep the control loop efficient

- In one orchestration turn, consume all currently available results and feedback, make one coherent plan update, and dispatch the next authorized work package when the bound task is idle. Do not stop after metadata repair, status narration, or a plan PATCH while executable work remains.
- Batch independent Manager reads, plan summaries, candidate details, task-state checks, feedback reads, and evidence checks. Run disjoint read-only or validation work in parallel when the available tools support it; keep dependent writes and irreversible actions ordered.
- Reuse verified facts and record consumption checkpoints such as `sessionId + turnId`, feedback IDs, plan revision, and evidence references. Read the full history again only for first binding, changed scope, conflicting evidence, recovery, or an explicit audit. Normal continuation reads the current plan and only the unconsumed delta.
- Prefer the largest safe work package that can run without another decision. A package may contain several ordered actions, files, checks, and independent subchecks when they serve the same current-step outcome. Do not create a new dispatch for each command, file, test, or plan-field update.
- Stop the loop only for terminal acceptance, explicit pause or cancellation, a still-running task or long process, a complete pending approval, a genuine external result with no authorized local action, or an authority boundary. Tool count, elapsed time, one failed attempt, and a successful status update are not stop conditions.

## Run the orchestration workflow

### 1. Deduplicate the plan

1. Page through plan summaries with `GET /api/roles/:roleId/plans`, including enough active and recent terminal records to find the target.
2. Select candidates using the goal, project/workspace, deliverables, scope, acceptance criteria, and stable keywords.
3. Read every plausible candidate in full with `GET /api/roles/:roleId/plans/:planId`.
4. Reuse the existing `planId` when the intended outcome, scope, and acceptance criteria match. Do not merge plans merely because their titles or keywords overlap.
5. Create a new plan only when no candidate represents the same commitment. Split independent outcomes into child or sibling plans, each with its own task binding.
6. If the matching plan is bound to another valid business task, stop business work in the current task and deliver only the new user requirements, evidence, attachments, and acceptance changes to that exact binding. Do not run a second investigation or implementation in parallel.

Before creating or repairing a plan, GET `/api/roles/:roleId/plan-statuses`. Write only an enabled status `key` from that persona's `planWorkflow.statuses` to `plan.status`. Use `planWorkflow.roles` to resolve analysis, information-needed, approval, execution, package, QA, discussion, pause, completion, and closure semantics. Labels, descriptions, colors, order, views, and lifecycle behavior come from the same persona configuration and must never be copied into code as a status enum.

`archiveStatus` is separate and accepts only `未归档` or `已归档`. Only a terminal status configured with `archiveEligible=true` may become `已归档` after `archiveAfterHours`. Archived plans do not participate in keyword recall.

Maintain exactly one current step for an active plan and point `currentStepId` to it. Steps do not store a status. `currentStepId` identifies the step being handled, `completedAt` records a finished step, and later steps carry neither field until selected.

Plan status is the single lifecycle state. Read the enabled keys and their meaning from the persona's `personaConfig.json.planWorkflow.statuses` through the Manager workflow endpoint; each plan stores only the selected key in `plan.status` and does not repeat the status catalog.

### 2. Design the executable step path

Before binding or dispatching work, classify the plan's actual phase from the latest plan, bound-task history, feedback, and evidence. Do not infer the phase from the title, an old local note, or a generic lifecycle status.

1. If the plan already has a `currentStepId`, treat that step as the highest-priority work item. Finish it, revise it, or explicitly replace it before selecting a later step. Do not skip claimed work merely because a newer request looks easier.
2. For a single change item, keep the visible path to the configured milestones: `roles.analysis`, optional `roles.informationNeeded`, `roles.approval` when owner approval is required, `roles.execution`, then `roles.waitingPackage` and `roles.waitingQa` only when a target package is required, and finally `roles.completed` or `roles.closed`. Put evidence collection inside analysis; put implementation review, tests, synchronization, submission, and readback inside execution. Do not invent a separate Rabi “待验收” status or create visible steps for every control-plane read, command, file, test, attachment update, or status write.
3. Give every step one observable outcome. Its title and `detail` should make the following recoverable: entry evidence, concrete action, expected artifact or state change, pass/fail check, and failure route. Put a real external dependency in `waitingFor`; put a real decision gate in `approvalRequest`. Do not use titles such as `继续处理`, `推进任务`, `等待环境`, or `验证一下` without the object and success condition.
4. Keep steps coarse enough to represent business state, not Agent activity. Combine all actions that must succeed for one state transition into the same step. Split different features, bugs, pages, or independently accepted outcomes into separate plans rather than adding unrelated steps to one plan.
5. When a step passes its check, write `completedAt`. When work advances, set `currentStepId` to the next step; a later step has no separate “未开始” value. Reopen a completed step only when later evidence invalidates its check, QA fails, or the user changes the accepted contract; clear its `completedAt`, record the reason, and update affected later steps.
6. Before dispatching a newly selected step, PATCH the same plan with that `currentStepId`, update `currentStep`, `nextAction`, and `waitingFor`, then reread the Manager result. If the write or readback fails, do not dispatch. This is the claim boundary that prevents two tasks or turns from starting the same work.
7. If the current step is no longer executable, revise it into a concrete clarification, approval, dependency, recovery, or evidence step; update later steps to match the new facts. If the new outcome is independently acceptable, split it into another plan.
8. When guidance, approval feedback, QA failure, or new source evidence arrives, consume every unhandled item that affects the plan, update the remaining step path first, and only then continue the bound task. Preserve feedback and prior evidence as audit history instead of overwriting why the path changed.

Borrow execution mechanics from specialized workflows without copying their external table columns. For a single change item, write the canonical workflow phase directly to `plan.status`; `currentStep`, `waitingFor`, approval metadata, and step IDs must not derive another displayed status.

### 3. Use one canonical change-state machine

Use this state machine for a bug, requested modification, document change, UI change, configuration change, or other single item that needs investigation, owner approval, implementation, and acceptance:

分析完成后的两个正常出口是 `roles.analysis → roles.informationNeeded` 和 `roles.analysis → roles.approval`：关键事实不足、不能确定是否需要改或怎么改，就进入待补充信息；证据充分、具体方案成立且需要负责人决定，才进入待审批。仍有可自主完成的相关调查时继续分析；已修复或无效事项按证据走原有验收或关闭流程。派发不得把“全部推进至待审批”当作固定终点，也不强制每项给两个方案。

`roles.analysis → roles.informationNeeded → roles.analysis`

`roles.analysis → roles.approval → roles.execution → roles.waitingPackage → roles.waitingQa → roles.completed`

`roles.approval --负责人要求修改--> roles.analysis`

`roles.waitingQa --验收失败--> roles.analysis`

`roles.analysis --确认问题无效或历史上已修复且无需验收--> roles.closed`

Investigation, solution design, and approval preparation use the key referenced by `roles.analysis`. When analysis is complete but a load-bearing fact is still missing, use `roles.informationNeeded`. A complete submitted approval contract uses `roles.approval`. Implementation and development validation after approval or explicit direct authorization use `roles.execution`. Package and QA waits use their configured role keys. Manager returns the key separately from the configured label, description, palette, order, and views; WebGUI and Qt consume that presentation instead of interpreting the key.

When an external collaboration source explicitly marks the item as waiting for discussion, write the key referenced by `roles.discussion` and preserve the recoverable current step. Do not infer it from titles, detail, or `waitingFor`.

Reserve `qa-*` and `verify-*` step IDs for actual target-package QA or acceptance. Use `audit-*`, `review-*`, `validate-*`, or another concrete non-QA prefix for developer checks, policy audits, prompt validation, compilation, and static verification. Step IDs help orchestration but never decide `plan.status`.

#### 分析中

- Set `plan.status` to the key referenced by `roles.analysis`.
- Collect the relevant source, code, configuration, Prefab, runtime, screenshot, log, history, and owner evidence in the largest safe batch.
- 离开调查前先给有依据的结论。方案成立时写现象、原因或决定依据、精确改动和验证；信息不足时写已确认事实、关键缺口及补证动作，不强行填写根因和修改清单。
- Do not enter approval merely because investigation started, an Agent has a guess, or someone must answer a question. Approval is only for a complete proposed change.

审批使用 Agent 在当前步骤 `questions` 中提供的业务问题和选项；没有任何自定义选项时，界面才补“按此方案执行／提出审批建议”默认操作。默认操作不是两套业务方案。所有选项均不预选；`requiresText=true` 要求附加文字，`requireOption=true` 要求明确选择；资料或问题变化后重新确认。

#### 待补充信息

- 根据问题先查现有代码、配置、设计、文档和附件。计划必须列出现有资料、已查结果、分析到哪一步卡住，以及为何仍不能确定问题；尚有可自主开展的相关调查时保持分析中。不得因缺日志或复现步骤直接退回，能静态确定的缺陷应形成具体方案。
- 待补充信息和待审批都要实际提出用户可回答的问题。在当前步骤的 `questions` 中保存 `id`、`prompt`、可选的 `context`、`selectionMode`、`implementation`、`options`、`placeholder`、`required` 和 `requireOption`；选项包含稳定 `id`、`label`、可选说明 `description`、`recommended`、`requiresText`、`exclusive` 与 `implementation`。无选项时展示输入框，有选项时仍保留自由输入；推荐不代表已选择或批准。
- 问题应说明最少缺什么、为什么影响判断、向谁或哪个来源询问、收到后做什么。缺资料记录不能代替询问。用户回答通过既有计划引导/审批反馈保存并投递原绑定任务；先消费答案再推进，不能把提交答案直接视为批准实施。问题或步骤改变后必须重新确认答案。
- 字段限制及公开 API 示例见 [计划问题与回答](../../docs/plan-and-memory-model.md#计划问题与回答)。旧计划没有 `questions` 时继续使用自由文字反馈；复核时由 Agent 补实际问题，不从标题自动生成答案或审批结论。

- Set `plan.status` to the key referenced by `roles.informationNeeded`.
- Enter `待补充信息` only after analysis has finished and the available information cannot support a concrete proposal that is ready for approval. The missing fact must affect the cause, proposed fix, implementation scope, or acceptance contract.
- 当前包无法复现或可能已有相关修复时，先核对修复覆盖和现有证据；查证后仍缺影响问题是否存在或改法的关键事实，就进入 `roles.informationNeeded`，不能用候选原因和将来验证冒充完整方案。已明确完成开发、仅缺包或 QA 时走 `roles.waitingPackage`／`roles.waitingQa`；确认无需修改且无需验收时按证据关闭。
- Set the current step ID to `information-needed-*`. In `detail`, list what is already known, why it is insufficient, and which conclusion cannot yet be made. In `waitingFor`, name the responsible person or source and the exact questions, screenshots, reproduction steps, configuration IDs, logs, decisions, or other evidence required.
- Clear any stale `approvalRequest`. Information collection is not approval.
- Continue every authorized independent investigation while waiting. 收到补充后完成信息步骤，先把状态回写为 `roles.analysis`，新建或重开 `investigate-*` 并重新分析；仍缺关键事实则再次进入 `roles.informationNeeded`，形成明确方案才进入 `roles.approval`。

#### 方案与问题的写法

- 提出审批前先核对本轮需求、当前实现、已有修复与负责人最新结论，说明现状为何仍需修改。已修复、无需修改或用户明确保留现状时，记录证据和决定，按现有验收或关闭流程处理；不要为旧问题增加新的体验需求或防御性重构。用户用业务案例讨论工作流时，只优化规则，不顺手处理案例计划。
- 面向审批人的正文先说清“现在怎样、准备怎样改、改哪里”。先解释逻辑从什么行为改成什么行为，再列代码文件／类或方法、预制体路径／对象／组件／绑定、配置表／行或 ID／字段各改什么；只列实际涉及项，不只堆文件名。
- 保留完整主谓宾：哪个玩家、系统或模块，在什么条件下，对哪个具体对象，做什么。可以删修饰词，不能删业务执行者、对象所属功能和必要条件。奖励写所属玩法和具体档位，按钮写页面和名称，不能缩成“首档自动领取、恢复界面”。代码、预制体和配置的具体标识放在改动清单，不把任务编号和条件缩写挤进一句话。
- 只有需要负责人取舍时才列不同方案，并分别写清差别；审批界面的“执行／提出建议”不等于必须设计 A／B 两套业务方案。混合问题分开写，未确认的修改不能放进所有方案的共同范围。
- 验证、风险、回退和排除项保留在技术详情或完整审批合同中；仅影响本次选择的内容放进正文。字段完整与文件存在不证明方案成立，协调者还须核对依据和读者能否看懂每项改动。
- 待补充信息直接写“已确认什么、还不知道什么、因此不能决定什么、下一步向谁或哪里核实”。不要求用户理解“补充复现合同、完成边界收口”等内部用语。

#### 待审批

- 实施明细使用 `questions[].implementation`：一题对应一个明确方案时放在题目上；确有多个候选或独立可选改动时，各自放在 `options[].implementation`，不把所有文件混成一份公共明细。明细包含 `changes[]`，每项写 `kind`（`code/prefab/art/configuration/other`）、`path`、可选 `target`（方法／对象／字段）和 `change`（具体怎么改），另可写 `validation`、`rollback`。正文只留结论和短摘要，明细默认折叠。`approvalRequest` 保留授权范围与来源，不能把所有候选的改动当作已获批范围；`alternatives` 可省略，不再强制备选。

- 待审批表示方案已形成、准备实施但尚未实施，通常审批一个明确方案是否执行；待补充信息表示暂时无法形成方案，需要用户补充影响判断的事实或决定。收到补充后先回到分析中，重新核对，再判断继续补充信息还是形成方案待审批，不能直接跳到审批或执行。普通修复不默认生成 A／B；玩法设计、美术候选等任务本身需要比较设计时，才按实际需要提供成熟候选，不用候选掩盖调查不足。信息充分且定位准确的小 Bug 直接形成方案，不为走流程要求用户补资料。Agent 判断下一步需要改动项目代码、预制体、美术资源或配置时，先进入待审批，不能以“小改动”或“验证猜测”为由先改项目。用户已明确批准同一具体修改时按授权范围执行，不重复审批；隔离草稿或设计候选不算已经修改项目。

- 审批通常询问明确方案是否执行；一个计划有多个独立决定时按需分题。确实存在设计候选时，分别写入 `questions[].options`，不要只把 A／B 塞进 `approvalRequest.request`、`alternatives` 或长段正文。`label` 写清动作和对象，`description` 说明改变的逻辑及影响，具体文件／组件／字段放在对应方案详情。每步最多 5 道题、每题最多 6 个选项。Agent 按决策关系设置 `selectionMode`：互斥方案用 `single`，可同时实施的选项用 `multiple`；省略时兼容为单选。同一计划包含不同事项或模块时，按需拆成多道题，可以混用单选、多选和文字题，不为凑数量拆题。同一项修改必须联动的模块放在一题里，写清依赖和涉及文件；不能把不可独立实施的改动伪装成可任意多选。各题独立决定，批准一题不表示批准其它题；一题待补证不能迫使其它题默认获批。多选中的“都不做，保持现状”设置 `exclusive: true`，不得与实施项同选。
- 可选变更提供“都不做，保持现状”和提出修改建议的入口；明确拒绝不是未答题，也不是批准其它选项。反馈必须对应原问题及所选选项，只有明确获批的范围才可实施，拒绝项和未决定项不得随其它修改执行。用户明确取消需求时记录决定并关闭相应需求；混合计划保留其它独立事项，不自动重提被否决方案。

- Set `plan.status` to `roles.approval` only when the current approval contract is complete and `responseStatus=pending`.
- Enter `待审批` only after investigation produced a complete review package. The current `approve-*` step must carry a complete `approvalRequest`, and the plan must already state the cause, exact changes, affected files/components/configuration, impact, validation, rollback, and exclusions.
- If any of those items is missing, remove the incomplete approval contract and return to `roles.analysis` or `roles.informationNeeded`, based on whether independent analysis remains. Do not leave a plan in pending approval with only a title, generic request, or unexplained waiting text.
- An approval request asks the responsible owner to approve or revise the written proposal. It must not ask the owner to perform the Agent's investigation or invent the change plan.
- On approval, complete the approval decision step, set `plan.status` to `roles.execution`, select `implement-*`, and dispatch implementation in the same orchestration turn.
- When the owner adds a correction, objection, or note, record that approval decision, preserve the feedback, and create `investigate-revision-*` as the single current step. Recheck the evidence and rewrite the proposal before requesting approval again; do not keep the rejected proposal in `待审批`.

#### 执行中、等待打包与等待 QA

- `执行中` starts only from an approved proposal or an explicit user instruction that already authorizes the same concrete change. Bind the implementation package to that approved cause, change list, scope, and validation method.
- Every current implementation or development-validation plan must use the key referenced by `roles.execution`; do not rely on its title to classify the plan.
- After implementation, Agent-owned review, required tests, applicable synchronization/submission, and conflict-free readback pass, leave `执行中`. Do not send the item back to approval merely because implementation finished.
- If development-side work is complete but the target package or inclusion proof is missing, set `plan.status` to `roles.waitingPackage`. After the target package is confirmed, set it to `roles.waitingQa` until the QA conclusion arrives.
- If no target package is required, keep direct owner acceptance in `roles.execution` with a `manual-verify-*` step. `manual-verify-*` is a step, not another plan status.
- If evidence shows the reported issue is invalid or was already fixed historically and no acceptance remains, set `plan.status` to `roles.closed`, preserve the evidence, and do not route it through information-needed, package, or QA states.
- On acceptance failure, preserve the failure evidence and return to `roles.analysis` with `investigate-revision-*`. Re-establish the cause and proposal before another implementation attempt.
- Complete the plan only when the acceptance result passes and every required delivery step has evidence.

When opening or reconciling an existing plan, repair state drift before dispatch: incomplete approval becomes `roles.analysis` or, only when no approvable proposal can be formed, `roles.informationNeeded`; implemented work becomes `roles.waitingPackage`, `roles.waitingQa`, or direct acceptance in `roles.execution`; rejected approval or failed acceptance returns to investigation; invalid or historically fixed work with no acceptance remaining becomes `roles.closed`. Perform the repair and the next authorized action in the same orchestration turn.

### 4. Resolve the unique task binding

1. If `taskBinding` exists, read the exact task by its full `sessionId`.
2. Accept the binding when the exact task exists and is not archived. Ignore title and saved-cwd drift; the full task ID identifies the task, while `taskBinding.workspace` supplies the execution directory for each plan delivery.
3. If the binding is missing, search Desktop tasks by project, outcome, deliverable, and acceptance criteria. Read plausible task histories from the initial request through the latest result.
4. Reuse a task only when its full history confirms the same plan scope. Stop for the smallest necessary clarification when multiple candidates remain genuinely ambiguous.
5. Create one task in the plan's project workspace only when no matching task exists. Put the plan ID, scope, current step, acceptance criteria, evidence, and authority boundaries in the initial prompt.
6. Persist the returned full task ID and canonical workspace in `taskBinding` immediately. If task creation succeeded but its initial turn failed, retry with `send` to that same ID; never create another task.

### 5. Maintain plan attachments

At plan creation and after each material stage, inventory the files already available to the task. Attach the files that materially support the current decision or acceptance, including source documents, user screenshots, reference art, diagrams, reports, generated art, design previews, recorded demonstrations, implementation screenshots, test reports, and final acceptance evidence.

- Inspect each attachment before adding it. Use readable names that distinguish source reference, candidate design, current implementation, and final acceptance.
- Prefer the smallest set that preserves the decision and acceptance record. When API count or size limits prevent attaching everything, keep the highest-value files and record the controlled location and omission reason in the plan.
- Never attach secrets, tokens, cookies, private conversations, player-private data, unrelated windows, or files outside the task's authority.
- Attachments supplement evidence. They do not replace source attribution, tests, revisions, package identity, delivery receipts, or QA results.
- On PATCH, preserve existing managed attachment objects unless an attachment is intentionally removed. Do not accidentally clear the list while adding a new stage artifact.

An archived, missing, or workspace-mismatched bound task fails closed. Do not silently replace it. Use the recovery procedure below.

### 6. Dispatch the largest safe work package

Before every dispatch:

1. Read the current plan, bound-task state, every unconsumed task result, new feedback, and new evidence. Read the full task history only when the binding or scope is unverified, evidence conflicts, or recovery requires it.
2. Consume all available completed work in one pass and PATCH the plan once before asking for more work. Do not issue separate writes for narration, intermediate commands, or unchanged fields.
3. Build the largest safe work package that can complete the current step without another decision. Include all ordered actions, files, checks, expected outputs, pass/fail conditions, and explicit stop conditions needed for that outcome; do not reduce the package to one command or one tiny action.
4. Batch independent reads, queries, and validation targets. Parallelize disjoint subtasks only when the bound task's tools, policy, and write ownership allow it; keep dependent mutations ordered and preserve one business task per plan.
5. Send the package once to the exact `sessionId + workspace`. Instruct the bound task to continue through the package until the current-step check passes or a real stop condition is reached.

Do not send a generic "continue". Include only the delta the task needs: the verified checkpoint, remaining package, acceptance check, and changed authority or stop boundary.

For projects with a user-owned Unity Editor and a designated upstream checkout, an open or busy Unity Editor, another task's Unity test, an import, or a shared test queue is not a reason to stop the business task or defer all work. Keep the existing Editor running and do not cancel or replace another task's run. Continue implementation, narrow SVN updates and merges, static asset/Prefab/config checks, non-Unity runners, CLI checks, and other independent work in parallel. If the remaining Unity interaction cannot be run without disturbing the current Editor, record it as an explicit human/runtime acceptance item and continue the rest of the plan. Test availability must not become a global development lock.

### 7. Consume results and prove status

A created task, accepted dispatch, completed turn, command exit code, or produced draft is not plan completion.

After a task turn or completion-hook reminder:

1. Read every unconsumed official result together with the artifacts or test evidence it cites.
2. Compare the combined evidence with the current step and plan acceptance criteria.
3. Set a step's `completedAt` only when its own check passes. Then point `currentStepId` to the next step.
4. PATCH the plan once with real progress, output references, waiting state, next action, and the latest consumption checkpoint.
5. Add or update the material stage attachments, or record why no useful attachment exists.
6. Reread the returned plan and current task state. If the task is idle and the next step is authorized and actionable, dispatch its work package in the same orchestration turn. Do not wait for another reminder or user message merely because the previous step completed.
7. If validation fails, keep the same plan and task, revise the current step or package from the failure evidence, and retry with a changed method. Do not return to broad discovery or stop at the failure report while a local recovery remains.

Completion reminders are deduplicated by `sessionId + turnId`, but they do not update the plan automatically. Consume each result once.

### 8. Handle waiting, feedback, and approval

- Keep `plan.status` equal to the enabled key for the actual configured phase. Missing load-bearing data after analysis uses `roles.informationNeeded` with `information-needed-*`; ongoing investigation uses `roles.analysis`; a submitted complete proposal uses `roles.approval`; implementation uses `roles.execution`; package and QA waits use their configured role keys.
- Do not put a project plan into a wait-only state merely because Main Unity is open, importing, running another test, unavailable through MCP, or shared by another task. Remove that condition from `waitingFor` when independent implementation or verification remains. Dispatch the original bound task to continue in formal Main without stopping the Editor; prefer static resource contracts, direct serialization checks, non-Unity runners, and CLI validation. Leave only the specific runtime interaction for human or later Unity acceptance when it cannot run concurrently.
- For SVN projects whose business implementation and working-copy direction are already authorized, treat routine synchronization and SVN submission inside the verified plan scope as an actionable delivery step, not a new approval gate. When source, direction, files, dependency closure, ownership, and conflict-free status are verified, remove stale sync-only `approvalRequest` / `waitingFor` text and dispatch the original bound task to update, merge, synchronize, submit, and read back. Stop only for an explicit read-only or no-submit instruction, unresolved ownership, semantic conflict, extra files, scope expansion, frozen-build changes, production, upload, publish, or external delivery.
- A lifecycle audit correction is incomplete if it only rewrites `steps`, `currentStep`, or `nextAction`. When synchronization, submission, or conflict-free readback is still missing and the bound task is idle, write an executable delivery-closure step, clear evidence-request wording from `waitingFor`, and dispatch that original task in the same orchestration turn. Do not stop after correcting structured fields or ask the task to merely report what another actor should execute. “Do not expand business scope” excludes extra files and new semantics; it does not exclude synchronization, SVN submission, or readback already required by the approved plan.
- Store only enabled keys returned by the persona's plan-status catalog. Store archival separately as `archiveStatus=未归档 | 已归档`; never infer it from a status label or key.
- A delivery-closure dispatch must require the bound task to write revision, exact changed paths, and the machine-readable sentence `无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *`. Generic text such as “已回读”, “无目标 diff”, or “无远端更新” is not enough.
- The designated project Unity Editor remains user-owned. Every renamed wait for a test environment, Unity, Editor, MCP, runner, import, compilation, PlayMode, GameView, shared tests, or a test slot is actionable rather than a valid waiting stage. Keep the existing Editor running and dispatch all independent implementation, static/CLI/non-Unity tests, synchronization, submission, and readback; after that delivery closure, enter package waiting. Put UI, Prefab, Scene, serialized-reference, Unity-lifecycle, and real-interaction checks in target-package QA: immediately visible checks go to the user, ordinary repeatable checks go to QA, and difficult checks go to QA first and reach the user only if QA explicitly cannot cover them. Compilation or `matched=0` is never acceptance evidence.
- QA tests only the already-built target package. Write human-executable instructions that identify the page, button, and visible visual or numeric result. Never ask QA to inspect logs, SVN revisions, hashes, fields, static contracts, or to run callback/validation tools; keep those as development-side package-entry evidence.
- Do not write `isBlocked`. It is a Manager-derived compatibility projection, not an Agent input or state truth. `blockedBy` is explanatory text only.
- For an approval, authorization, or decision gate, PATCH a complete current-step `approvalRequest` with the approver, concrete request, recommendation, optional design alternatives, reason, affected files/commands/changes, validation, rollback, out-of-scope items, request source, and `responseStatus=pending`. At least one of files, commands, or changes must be concrete.
- Treat `presentation.approval.state=ready` and `enabled=true` as proof that the approval contract is submit-ready. While it is pending, do not dispatch implementation beyond the approved contract; continue only authorized clarification and evidence work.
- Treat guidance and approval feedback as evidence that requires an Agent decision and explicit PATCH, not a Manager-side automatic transition. A correction, objection, or rejected proposal returns the same item to `investigate-revision-*`; an approval advances it to `implement-*` in the same orchestration turn. Then write the matching Agent response record once.
- If no authorized outbound channel exists, prepare the exact question or draft and request authority instead of claiming that a person was contacted.

### 9. Pause, resume, and close

- Pause only after an explicit user, owner, or policy instruction. Keep `currentStepId` as the recovery point, and stop task dispatches.
- Resume by PATCHing the top-level status to the actual phase, normally `分析中` or `执行中`, rereading the recovery point, and continuing the original bound task.
- Mark the plan `完成` only after every acceptance criterion has evidence. Keep failed validation in the same plan and task.
- For bulk cleanup, migration, or synchronization, record a `completionCoverage` evidence block with `baselineTotal`, `processed`, `deleted`, `alreadyAbsent`, `retained`, `blocked`, and `remaining`. Before completion, verify `processed + remaining = baselineTotal` and `deleted + alreadyAbsent + retained + blocked = processed`; `remaining`, `retained`, and `blocked` must all be zero. A conflict-free SVN status, a commit revision, or a few exact paths only proves that level. A screenshot, later message, or temporary path list that narrows work must be recorded as `仅完成子范围`; keep the original plan active or split an independent subgoal. Without `baselineTotal`, report `目标清单待恢复`, not plan completion.
- Set `status=关闭` only for explicit cancellation, confirmed invalidity, or a recorded successor. Preserve the old/new mapping and reason when a successor takes over. Do not mark it archived immediately; automatic archival changes only `archiveStatus` after the configured delay.

## Prevent duplicate delivery

| Observed state | Required action |
| --- | --- |
| Bound task is `active` or `in-progress` | Do not resend the same next action. Observe or wait for the turn result. |
| Bound task is idle and the plan has an authorized actionable step | Send one precise next action, then verify acceptance. |
| Delivery is `uncertain` or `sent_unverified` | Preserve the uncertainty and inspect task history/status; do not auto-resend. |
| Task was created but its initial turn failed | Save the returned ID and retry that same task with `send`. |
| The same plan is mentioned again | Reuse its `planId` and bound task after rereading both. |
| A completion reminder repeats | Consume the `sessionId + turnId` result once; do not create work from the duplicate. |
| The plan is paused or has a pending ready approval | Do not dispatch implementation. |
| The bound task is archived, absent, or in another workspace | Fail closed and perform controlled recovery. |

Only steer an active task when genuinely new user input must alter the running turn and the owner interface explicitly supports steering. Never use steering as a heartbeat.

## Recover or migrate a binding

1. Recheck the exact task ID, archived state, workspace, Desktop owner availability, and latest task history.
2. Retry loading the same owner when the task exists but is temporarily unavailable. Do not use CLI, isolated app-server execution, or another Runtime.
3. If the task is genuinely unrecoverable, collect the old task ID, last verified result, incomplete work, current plan step, acceptance criteria, authority limits, and recovery reason.
4. Create at most one replacement task in the same canonical workspace, hand over that evidence, and PATCH the plan with the old/new IDs and migration reason.
5. Verify the new binding by exact ID before dispatching additional work.

Do not change a valid binding merely to rename, repartition a coordinator, clear a pause, or react to a stale display title.

## Finish with an audit

Before reporting completion, verify:

- no duplicate plan represents the same commitment;
- the plan has one focus and one valid current step pointer;
- exactly one business task is bound by full ID, with one explicit execution workspace recorded;
- no identical instruction was dispatched twice;
- waits and approvals match Manager-derived presentation;
- every completed step and terminal state has acceptance evidence;
- useful source, design, implementation, test, and acceptance files are attached or have a recorded omission reason;
- Manager writes were reread successfully when Manager was available; otherwise the availability failure and any read-only local recovery were recorded without blocking project completion;
- no private role data, runtime logs, tokens, or relationship/persona content entered this project-level skill or public examples.

## Optional notification channels

When the intended destination is known, prefer adding `messageChannels` during plan creation or PATCH. Use the current Manager Route and endpoint catalog; entries are `{channel, gatewayId, params}`. NapCat params are `target` (`group` or `private`), `targetId`, and `instanceId`; speech uses the selected Route. This is a preference, never a required admission field. If unknown, omit it and continue: existing persona event rules still deliver. Do not invent a destination or an original QQ message ID. Hook notifications may be standalone; direct Agent replies should quote the source when available.
