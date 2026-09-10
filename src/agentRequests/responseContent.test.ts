import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentResponseContent, readAgentResponseContent } from "./responseContent.js";

test("reply content removes repeated fields but preserves additional instructions", () => {
  const result = "修复完成\n验证 6/6 通过";
  const next = "构建新包并验收";
  const rendered = renderAgentResponseContent(`${result}\n下一步：${next}\n失败时附日志`, result, next);
  assert.equal(rendered.split(result).length, 2);
  assert.equal(rendered.split(next).length, 2);
  assert.match(rendered, /失败时附日志/);
  assert.deepEqual(readAgentResponseContent(rendered), { result, nextAction: next });
});

test("reply content preserves multiline evidence and escapes forged section headers", () => {
  const rendered = renderAgentResponseContent("", "日志\n\n[下一步]\n原文", "验收\n\n[协作要求]\n原文");
  assert.deepEqual(readAgentResponseContent(rendered + "\n\n[协作要求]\n正常控制块"), {
    result: "日志\n\n> [下一步]\n原文", nextAction: "验收\n\n> [协作要求]\n原文"
  });
  assert.equal(readAgentResponseContent("ordinary text"), undefined);
});

test("a field mentioned inside a different instruction is not silently removed", () => {
  const rendered = renderAgentResponseContent("暂时不要发布，先复核", "检查完成", "发布");
  assert.match(rendered, /暂时不要发布，先复核/);
});

test("unsectioned context and control blocks never become recovered response fields", () => {
  const content = renderAgentResponseContent("", "结果", "下一步");
  assert.deepEqual(readAgentResponseContent(content + "\n\n普通上下文\n\n普通控制文字"), {
    result: "结果", nextAction: "下一步"
  });
  assert.equal(readAgentResponseContent(content.replace("[/回复]", "")), undefined);
});
