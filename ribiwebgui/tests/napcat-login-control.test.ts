import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { translateText, setLocale } from "../src/i18n/index";

const pageSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const quickSetupSource = fs.readFileSync(new URL("../src/components/QuickSetupDialog.vue", import.meta.url), "utf8");

test("NapCat login copy switches languages without changing account identities or endpoints", () => {
  const cases = [
    ["QQ 已登录", "QQ signed in"],
    ["管理接口", "Management API"],
    ["NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。", "NapCat is not bound to an enabled Rabi Route and cannot start or sign in."],
    ["一条路由只能绑定一个 QQ，请为另一个 QQ 新建路由。", "A Route can bind only one QQ account. Create another Route for a different account."],
    ["NapCat 停止失败，已阻止重新启动；请重试解绑。", "NapCat could not stop. Restart is blocked; retry removing the binding."],
    ["登录 QQ 与当前路由绑定的账号不一致，请使用绑定账号。", "The sign-in account does not match this Route. Use the bound QQ account."],
    ["NapCat 会话", "NapCat session"],
    ["http://127.0.0.1:6099/webui · 可用", "http://127.0.0.1:6099/webui · available"],
    ["一键启动并在当前卡片管理登录；只有 QQ 安全验证需要你确认", "Start NapCat and manage sign-in on this card. Only QQ security verification needs your confirmation."],
    ["QQ 10000 已登录。", "QQ 10000 is signed in."],
    ["QQ 10000 已离线，请重新登录。", "QQ 10000 is offline. Sign in again."],
    ["扫码登录", "QR sign-in"],
    ["当前账号：QQ 10000 示例昵称", "Current account: QQ 10000 示例昵称"],
    ["此 Route 绑定 QQ 10000，但 OneBot HTTP 返回 QQ 20000 / 示例昵称；请检查此实例的 HTTP 地址。", "This Route is bound to QQ 10000, but OneBot HTTP returned QQ 20000 / 示例昵称. Check this instance's HTTP URL."],
    ["NapCat 管理服务未响应（http://127.0.0.1:6099/webui）；请启动此实例后刷新登录状态。", "NapCat management did not respond (http://127.0.0.1:6099/webui). Start this instance and refresh sign-in status."]
  ];
  try {
    setLocale("en");
    for (const [source, english] of cases) assert.equal(translateText(source), english);
    setLocale("zh-CN");
    for (const [source] of cases) assert.equal(translateText(source), source);
  } finally { setLocale("zh-CN"); }
});

test("NapCat login stays inside the Route card and exposes the three supported login modes", () => {
  assert.match(pageSource, /QQ 登录控制/);
  assert.match(pageSource, /<v-tab value="quick">快速登录<\/v-tab>/);
  assert.match(pageSource, /<v-tab value="password">密码登录<\/v-tab>/);
  assert.match(pageSource, /<v-tab value="qrcode">扫码登录<\/v-tab>/);
  assert.match(pageSource, /\/api\/message\/napcat-login-panel/);
  assert.match(pageSource, /\/api\/message\/napcat-login-action/);
  assert.match(pageSource, /action: "captcha-login"/);
  assert.match(pageSource, /action: "new-device-login"/);
  assert.match(quickSetupSource, /保存 Route 后，直接在 NapCat 卡片完成快速、密码或扫码登录/);
  for (const source of [pageSource, quickSetupSource]) {
    assert.doesNotMatch(source, /startNapcatAndOpen|openNapcatWebui|打开 NapCat|打开 WebUI|复制 WebUI 登录密钥/);
  }
});

test("NapCat hides login forms after authentication and rejects conflicting account logs", () => {
  assert.match(pageSource, /<v-tabs v-if="!napcatLoginUi\(instance\).panel\?\.loggedIn && napcatLoginUi\(instance\).panel\?\.managementAvailable"/);
  assert.match(pageSource, /<v-window v-if="!napcatLoginUi\(instance\).panel\?\.loggedIn && napcatLoginUi\(instance\).panel\?\.managementAvailable"/);
  const source = pageSource.match(/function napcatEntryMatchesInstance\([\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const matches = new Function("napcatAccountUserId", `${compiled}; return napcatEntryMatchesInstance;`)((instance: { botUserId: string }) => instance.botUserId);
  const instance = { id: "bot", botUserId: "10000", gatewayPort: 8789 };
  assert.equal(matches({ event: "login_info", instanceId: "bot", data: { userId: "20000" } }, instance, true), false);
  assert.equal(matches({ event: "login_info", instanceId: "bot", data: { userId: "10000" } }, instance, true), true);
  assert.equal(matches({ instanceId: "other", botUserId: "10000" }, instance, true), false);
  assert.equal(matches({ instanceId: "bot", port: 8790 }, instance, true), false);
});
