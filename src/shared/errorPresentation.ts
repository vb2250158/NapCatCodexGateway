/** Shared user-facing diagnostics. Machine codes and raw evidence remain unchanged. */
export type ErrorLocale = "zh-CN" | "en";
export type ErrorDetails = { reason?: string; state?: string; causeCode?: string; commitState?: string; nextAction?: string; requestId?: string; code?: unknown; errorMessages?: Partial<Record<ErrorLocale, string>> };
const reasons: Record<string, [string, string]> = {
  revision_conflict: ["资源版本已变化，请读取最新版本并合并修改。", "The resource revision changed. Read the latest version and merge your changes."],
  idempotency_conflict: ["同一幂等编号对应不同内容，请核对原操作。", "The same idempotency key identifies different content. Check the original operation."],
  invalid_request: ["请求参数未通过校验。", "Request parameters failed validation."],
  not_found: ["目标资源不存在或当前不可读取。", "The target resource does not exist or cannot currently be read."],
  busy: ["服务暂时繁忙，操作尚未开始。", "The service is busy; the operation has not started."],
  generation_mismatch: ["服务实例已更换，请重新连接并读取资源。", "The service instance changed. Reconnect and read the resource again."],
  projection_unavailable: ["资源视图暂不可读取。", "The resource view is temporarily unavailable."],
  agent_reply_state_conflict: ["原请求状态或回复任务身份不满足回传条件。", "The original request state or replying task identity does not permit this reply."],
  timeout: ["等待操作结果超时。", "Waiting for the operation result timed out."],
  worker_failed: ["处理操作的工作进程失败。", "The worker processing the operation failed."],
  termination_unconfirmed: ["未能确认工作进程已经停止。", "Worker termination has not been confirmed."],
  unauthorized: ["访问凭据缺失或已失效，请重新认证。", "Access credentials are missing or expired. Authenticate again."],
  forbidden: ["当前身份没有执行此操作的权限。", "The current identity is not permitted to perform this operation."],
  service_failure: ["服务处理失败，服务器未能完成请求。", "The service failed while processing the request."],
  request_failed: ["请求未完成，服务器未提供更具体原因。", "The request did not complete and no more specific cause was provided."],
};
const exact: Record<string, string> = {
  "The write succeeded. Read the resource to confirm its current contents; replay only the original payload with the same Idempotency-Key if the receipt is still needed.": "写入已成功。请读取资源确认内容；仍需回执时，仅用原内容和原 Idempotency-Key 重试。",
  "Read the resource and original operation receipt. Retry only the original payload with the same Idempotency-Key; do not create a replacement operation.": "请读取资源和原操作回执；仅用原内容和原 Idempotency-Key 重试，不要另建替代操作。",
  "GET the latest resource and strong ETag, merge your intended changes with the current contents, then submit with If-Match.": "GET 最新资源和强 ETag，合并修改后携带 If-Match 提交。",
  "This key already identifies a different payload. Read that operation first; use a new key only for a separate intended change.": "该编号已对应不同内容。先读取原操作，仅在另一次独立修改时使用新编号。",
  "Correct the field described in message, then submit the corrected payload with a new Idempotency-Key.": "修正报错指出的字段，再使用新的 Idempotency-Key 提交修正后的内容。",
  "Verify the role and resource ID, including archived plans. Do not recreate a plan just because this lookup failed.": "核对角色和资源编号，并检查已归档计划；不要因一次查询失败重建计划。",
  "Rediscover the Manager through Host, verify /meta, then read the resource again.": "通过 Host 重新发现 Manager，核对 /meta 后再次读取资源。",
  "The operation has not started. Check Manager readiness and retry the same operation after the reported delay.": "操作尚未开始。检查 Manager 是否就绪，等待响应指定时间后重试原操作。",

  "Plan feedback text is required.": "计划反馈正文不能为空。",
  "Plan attachments must be an array.": "计划附件必须是数组。",
  "Plan attachment mentions must be an array of attachment ids.": "附件引用必须是附件编号数组。",
  "Plan attachment mention id is required.": "附件引用缺少编号。",
  "Plan attachment mention ids must be unique.": "附件引用编号不能重复。",
  "Plan attachment not found.": "找不到计划附件。",
  "Invalid plan attachment path.": "计划附件路径缺失或编码无效。",
  "Invalid byte range.": "请求的文件字节范围无效。",
  "Method not allowed.": "此接口不支持当前请求方法。",
  "Request body is too large.": "请求正文超过接口允许的大小。",
  "Plan secretary Agent is not configured.": "计划未配置秘书 Agent。",
  "Plan task Agent is not configured.": "计划未配置执行 Agent。",
  "Plan status key is immutable.": "计划状态编号创建后不能修改。",
  "Plan feedback mutation identity is invalid.": "反馈身份无效：角色、计划编号或内容摘要缺失或格式错误。",
  "Plan feedback is still unresolved; retry the same content before submitting edited feedback.": "上一条反馈结果尚未确认，请先用原内容核对回执，再提交修改后的内容。",
  "Plan feedback requires a stable feedbackId.": "反馈缺少用于安全重试的固定 feedbackId。",
  "Plan feedback requires the exact strong ETag returned by Manager.": "反馈必须携带 Manager 最新返回的强 ETag。",
  "Manager did not return a strong plan storage ETag.": "Manager 响应缺少强 ETag，无法安全提交计划修改。",
  "Manager did not publish a complete lifecycle identity.": "Manager 未返回完整实例身份，无法确认当前连接目标。",
  "Weak ETags cannot guard a storage mutation.": "弱 ETag 不能用于保护写入，请读取最新强 ETag。",
  "Expected revision must contain one ETag.": "版本条件只能包含一个 ETag。",
  "Expected revision is invalid.": "版本条件格式无效。",
  "Plan catalog kept changing while loading; retry shortly.": "读取期间计划目录持续变化，请稍后重新读取。",
  "role must be task or secretary.": "role 必须为 task 或 secretary。",
};
function inferReason(message: string, status: number): string {
  if (status === 401 || /unauthorized|authentication|credentials? missing|token expired/i.test(message)) return "unauthorized";
  if (status === 403 || /permission|forbidden|access denied|EACCES|EPERM/i.test(message)) return "forbidden";
  if (status === 412 || /revision|etag|version conflict/i.test(message)) return "revision_conflict";
  if (status === 408 || status === 504 || /timed out|timeout/i.test(message)) return "timeout";
  if (status === 400 || status === 405 || status === 416 || /required|invalid|must be|exceeds|duplicat|byte range|method not allowed/i.test(message)) return "invalid_request";
  if (status === 404 || /not found|不存在|找不到/i.test(message)) return "not_found";
  if (status >= 500 || /worker|service unavailable|internal server|failed while processing/i.test(message)) return "service_failure";
  return "request_failed";
}
const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
  [/^(.+) is required\.$/, (_, field) => `${field} 不能为空。`],
  [/^(.+) must be an array\.$/, (_, field) => `${field} 必须是数组。`],
  [/^(.+) must be boolean\.$/, (_, field) => `${field} 必须是布尔值。`],
  [/^(.+) not found: (.+)$/, (_, kind, id) => `找不到 ${kind}：${id}`],
  [/^Plan not found: (.+)$/, (_, id) => `找不到计划：${id}`],
  [/^Plan feedback exceeds (\d+) characters\.$/, (_, count) => `计划反馈超过 ${count} 字符。`],
  [/^Plan attachment exceeds (\d+) bytes: (.+)\.$/, (_, count, name) => `附件 ${name} 超过 ${count} 字节。`],
  [/^Plan attachments exceed (\d+) bytes in total\.$/, (_, count) => `附件总大小超过 ${count} 字节。`],
  [/^A plan supports at most (\d+) attachments\.$/, (_, count) => `一个计划最多允许 ${count} 个附件。`],
  [/^Plan attachment (\d+) must provide exactly one of path or contentBase64\.$/, (_, index) => `第 ${index} 个附件必须且只能提供 path 或 contentBase64。`],
  [/^Plan attachment is not valid base64: (.+)\.$/, (_, name) => `附件 ${name} 的 Base64 内容无效。`],
  [/^Plan attachment content does not match its (image|video) type: (.+)\.$/, (_, kind, name) => `附件 ${name} 的内容与声明的${kind === "image" ? "图片" : "视频"}类型不符。`],
  [/^Plan attachment id is duplicated: (.+)\.$/, (_, id) => `附件编号重复：${id}。`],
  [/^Manager request timed out after (\d+)ms\.$/, (_, ms) => `Manager 在 ${ms} 毫秒内没有返回结果。`],
  [/^Manager request failed \(HTTP (\d+)\)\.$/, (_, code) => `Manager 请求失败，HTTP 状态码为 ${code}；响应未提供更具体原因。`],
];
export function translateErrorMessage(message: string, locale: ErrorLocale): string {
  if (locale === "en") return Object.entries(exact).find(([, zh]) => zh === message)?.[0] ?? message;
  if (exact[message]) return exact[message];
  if (message.includes("\n")) return message.split("\n").map(line => translateErrorMessage(line, locale)).join("\n");
  for (const [pattern, render] of patterns) { const match = message.match(pattern); if (match) return render(...match); }
  return message;
}
export function presentError(message: string, details: ErrorDetails = {}, locale: ErrorLocale = "zh-CN"): string {
  if (details.errorMessages?.[locale]) return details.errorMessages[locale]!;
  const en = locale === "en";
  if (/^(failed to fetch|fetch failed|load failed|networkerror|network request failed)/i.test(message)) {
    return en ? "No response was received from the service. Check the connection and service status. A write may already have reached the server; check its receipt before retrying."
      : "未收到服务响应，请检查网络和服务状态。写入可能已到达服务器，重试前请核对原操作回执。";
  }
  const code = details.reason || details.state || (typeof details.code === "string" ? details.code : "");
  const description = reasons[code]?.[en ? 1 : 0];
  const cause = details.causeCode ? reasons[details.causeCode]?.[en ? 1 : 0] || details.causeCode : "";
  const translated = translateErrorMessage(message.trim(), locale);
  const diagnostic = translated && !description ? (en ? "Cause: " : "原因：") + translated : translated;
  const lines = [description, cause, diagnostic || (en ? "The service did not provide a specific cause. Check the request log." : "服务未提供具体原因，请查看本次请求日志。")].filter(Boolean);
  if (details.commitState === "committed") lines.push(en ? "The write completed. Read the resource to confirm; do not submit another operation." : "写入已完成，请读取资源确认，不要重复提交。");
  else if (details.commitState === "unknown") lines.push(en ? "The write result is unknown. Check the original receipt; retry only the same payload and idempotency key." : "写入结果未知。请核对原回执；重试只能使用原内容和原幂等编号。");
  else if (details.commitState === "not_started") lines.push(en ? "This operation has not started." : "本次操作尚未开始。");
  if (details.nextAction && !message.includes(details.nextAction)) lines.push((en ? "Next action: " : "下一步：") + translateErrorMessage(details.nextAction, locale));
  if (details.requestId) lines.push(`requestId: ${details.requestId}`);
  return [...new Set(lines)].join("\n");
}
export function errorResponsePresentation(body: unknown, status: number): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const row = body as Record<string, unknown>;
  if (status < 400 && row.code !== -1 && row.ok !== false) return body;
  const nested = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : {};
  const message = typeof row.message === "string" ? row.message : typeof nested.message === "string" ? nested.message : typeof row.error === "string" ? row.error : `HTTP ${status}: no specific cause was supplied.`;
  const details = { ...row, ...nested } as ErrorDetails;
  if (!details.reason) details.reason = inferReason(message, status);
  return { ...row, reason: row.reason ?? details.reason, message: row.message ?? message, errorMessages: { "zh-CN": presentError(message, details, "zh-CN"), en: presentError(message, details, "en") } };
}
