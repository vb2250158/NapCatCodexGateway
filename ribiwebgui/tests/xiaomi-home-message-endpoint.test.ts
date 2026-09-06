import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { translateText } from "../src/i18n/index.js";
import {
  adapterLabel,
  adapterSourceAliases,
  routeKindDefinitionsForGateway
} from "../src/utils/gatewayHelpers.js";
import {
  HOME_ASSISTANT_AUTHENTICATION_DOCS_URL,
  HOME_ASSISTANT_INSTALLATION_URL,
  HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL,
  homeAssistantLoginUrl,
  homeAssistantProfileUrl
} from "../src/xiaomiHomeCredentialHelp.js";

const routeConfigSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const settingsPageSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const endpointRendererSource = fs.readFileSync(new URL("../src/components/renderers/XiaomiHomeSettingsRenderer.vue", import.meta.url), "utf8");
const authRendererSource = fs.readFileSync(new URL("../src/components/renderers/XiaomiHomeMessageEndpointRenderer.vue", import.meta.url), "utf8");

test("Route message endpoint catalog includes Xiaomi Home as a distinct smart-home input", () => {
  assert.match(routeConfigSource, /title: "智能家居"/);
  assert.match(routeConfigSource, /type: "xiaomiHome", title: "米家 \/ Xiaomi Home"/);
  assert.match(routeConfigSource, /"heartbeat", "xiaomiHome", "rabilink"/);
  assert.doesNotMatch(routeConfigSource, /type: "xiaoai", title:/);
  const quickSetupSource = fs.readFileSync(new URL("../src/components/QuickSetupDialog.vue", import.meta.url), "utf8");
  assert.doesNotMatch(quickSetupSource, /type: "xiaoai", title:/);
  assert.equal(routeKindDefinitionsForGateway().some((entry) => entry.adapter === "xiaoai"), false);
  assert.match(routeConfigSource, /route\.adapters\.message-endpoint-settings/);
  assert.match(routeConfigSource, /settingsRenderersForMessageEndpoint/);
  assert.match(endpointRendererSource, /此配置属于米家消息端/);
  assert.match(endpointRendererSource, /地址与登录凭据都在当前 Route/);
  assert.match(authRendererSource, /type="password"/);
  assert.match(authRendererSource, /xiaomiHomeAuthClient\.connect\(\{/);
  assert.match(authRendererSource, /accessToken\.value = ""/);
  assert.match(authRendererSource, /不是小米账号密码或设备 token/);
  assert.match(authRendererSource, /打开 Home Assistant/);
  assert.match(authRendererSource, /打开令牌管理/);
  assert.match(authRendererSource, /:disabled="!loginUrl"/);
  assert.match(authRendererSource, /:disabled="!profileUrl"/);
  assert.doesNotMatch(authRendererSource, /v-if="loginUrl"/);
  assert.doesNotMatch(authRendererSource, /v-if="profileUrl"/);
  assert.match(authRendererSource, /先填写有效的 Home Assistant 地址/);
  assert.match(authRendererSource, /怎样获取令牌？/);
  assert.match(authRendererSource, /v-expansion-panels/);
  assert.doesNotMatch(authRendererSource, /连接前准备两项/);
  assert.doesNotMatch(settingsPageSource, /XiaomiHome|xiaomi-home|米家/);
  assert.equal(adapterLabel("xiaomiHome"), "米家 / Xiaomi Home");
  assert.notEqual(adapterLabel("xiaomiHome"), adapterLabel("xiaoai"));
  assert.equal(adapterSourceAliases("xiaomiHome").includes("xiaomi"), false);
  assert.equal(adapterSourceAliases("xiaoai").includes("xiaomi"), true);
});

test("Xiaomi Home credential help links only create safe Home Assistant profile URLs", () => {
  assert.equal(homeAssistantLoginUrl("http://homeassistant.local:8123/config?next=1#fragment"), "http://homeassistant.local:8123/");
  assert.equal(homeAssistantProfileUrl("http://homeassistant.local:8123"), "http://homeassistant.local:8123/profile/security");
  assert.equal(homeAssistantProfileUrl("https://ha.example.test/config?next=1#fragment"), "https://ha.example.test/profile/security");
  assert.equal(homeAssistantProfileUrl("javascript:alert(1)"), "");
  assert.equal(homeAssistantProfileUrl("not a url"), "");
  assert.equal(homeAssistantLoginUrl("javascript:alert(1)"), "");
  for (const url of ["https://test-user:fake-password@ha.example.test", "https://test-user@ha.example.test", "https://:fake-password@ha.example.test"]) {
    assert.equal(homeAssistantLoginUrl(url), "");
    assert.equal(homeAssistantProfileUrl(url), "");
  }
  assert.equal(HOME_ASSISTANT_AUTHENTICATION_DOCS_URL, "https://www.home-assistant.io/docs/authentication/");
  assert.equal(HOME_ASSISTANT_INSTALLATION_URL, "https://www.home-assistant.io/installation/");
  assert.equal(HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL, "https://www.home-assistant.io/integrations/xiaomi_miio/");
});

test("Xiaomi Home rule catalog uses the owner event kind without a Gateway callback", () => {
  const definition = routeKindDefinitionsForGateway().find(item => item.adapter === "xiaomiHome");
  assert.deepEqual(definition?.groups, [{ title: "米家设备事件", routeKinds: ["xiaomi_home_event"] }]);
  assert.match(definition?.note ?? "", /不会启动 Gateway 常驻 adapter/);
});

test("Xiaomi Home UI copy is present in the English catalog", () => {
  assert.equal(translateText("米家 / Xiaomi Home", "en"), "Xiaomi Home");
  assert.equal(translateText("智能家居", "en"), "Smart home");
  assert.equal(translateText("Home Assistant 连接与事件", "en"), "Home Assistant connection and events");
  assert.equal(translateText("打开 Home Assistant", "en"), "Open Home Assistant");
  assert.equal(translateText("怎样获取令牌？", "en"), "How do I get a token?");
  assert.equal(translateText("先填写有效的 Home Assistant 地址。", "en"), "Enter a valid Home Assistant URL first.");
  assert.match(authRendererSource, /本机受保护凭证/);
});
