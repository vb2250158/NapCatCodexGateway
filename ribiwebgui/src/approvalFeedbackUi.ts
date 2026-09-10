import { presentError } from "../../src/shared/errorPresentation";
export function localizedPlanError(error: unknown, english = false): string {
  const value = error && typeof error === "object" ? error as { message?: string; details?: import("../../src/shared/errorPresentation").ErrorDetails } : {};
  return presentError(value.message ?? String(error || ""), value.details, english ? "en" : "zh-CN");
}
export function planFeedbackSubmissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error || "").trim();
  if (/failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)) {
    return "无法连接 Manager，服务可能正在重启或网络暂时中断。计划反馈内容已保留，请稍后重试。";
  }
  return localizedPlanError(error);
}
export const approvalSubmissionErrorMessage = planFeedbackSubmissionErrorMessage;
