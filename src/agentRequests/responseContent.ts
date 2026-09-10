import { normalizeRabiMessageContent } from "../shared/rabiMessage.js";

const resultHeader = "[回复结果]\n";
const nextHeader = "\n\n[下一步]\n";
const extraHeader = "\n\n[补充说明]\n";
const responseEnd = "\n\n[/回复]";

/** Keep response fields once, while retaining any distinct handoff instructions. */
export function renderAgentResponseContent(prompt: string, result: string, nextAction: string): string {
  const normalize = (value: string) => normalizeRabiMessageContent(value, true).replace(/\r\n/g, "\n").trim();
  const resultText = normalize(result);
  const nextText = normalize(nextAction);
  let extra = normalize(prompt);
  // Only remove exact fields; never summarize or truncate the sender's evidence.
  for (const field of [resultText, nextText].sort((a, b) => b.length - a.length)) {
    if (!field) continue;
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const repeatedField = new RegExp(`(^|\\n)(?:(?:回复结果|结果|下一步)[：:] *)?${escaped}(?=\\n|$)`);
    extra = extra.replace(repeatedField, "$1");
  }
  extra = extra.replace(/^\s*(?:回复结果|结果|下一步)[：:]\s*$/gm, "").trim();
  return `${resultHeader}${resultText}${nextHeader}${nextText}${responseEnd}${extra ? extraHeader + extra : ""}`;
}

export function readAgentResponseContent(content: string): { result: string; nextAction: string } | undefined {
  if (!content.startsWith(resultHeader)) return undefined;
  const end = content.indexOf(responseEnd);
  if (end < 0) return undefined;
  const parts = content.slice(resultHeader.length, end).split(nextHeader);
  if (parts.length !== 2) return undefined;
  const result = parts[0].trim();
  const nextAction = parts[1].trim();
  return result && nextAction ? { result, nextAction } : undefined;
}
