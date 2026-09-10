import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { errorResponsePresentation, presentError } from "./errorPresentation.js";
test("error presentation preserves cause and commit state", () => {
  const text = presentError("disk EACCES: item-17", { reason: "projection_unavailable", commitState: "unknown", requestId: "original" }, "zh-CN");
  assert.match(text, /资源视图暂不可读取/); assert.match(text, /结果未知/); assert.match(text, /EACCES/); assert.match(text, /original/);
});
test("parameter errors retain concrete limits", () => assert.equal(presentError("Plan attachment exceeds 1024 bytes: photo.png.", {}, "zh-CN"), "原因：附件 photo.png 超过 1024 字节。"));
test("error response adds both locales and preserves machine fields", () => {
  const result = errorResponsePresentation({ code: -1, message: "Plan feedback text is required.", retryable: false }, 400) as Record<string, any>;
  assert.equal(result.retryable, false); assert.match(result.errorMessages["zh-CN"], /正文不能为空/); assert.match(result.errorMessages.en, /text is required/); assert.equal(result.reason, "invalid_request");
  const success = { code: 0, data: { message: "user content" } }; assert.equal(errorResponsePresentation(success, 200), success);
});
test("unknown failures retain the original diagnostic", () => assert.match(presentError("vendor-specific-19", {}, "zh-CN"), /vendor-specific-19/));

test("localized errors do not duplicate an already rendered response", () => {
  assert.equal(presentError("original", { errorMessages: { "zh-CN": "服务忙", en: "Busy" } }, "en"), "Busy");
});
