import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { showsRouteSwitcher } from "../src/routeScopedNavigation";

test("route selector appears only on adapters, persona and knowledge pages", () => {
  for (const route of ["/routes", "/routes/main", "/routes/main/adapters", "/persona", "/persona/main", "/routes/main/persona", "/routes/main/persona/document", "/routes/main/persona/sync", "/knowledge", "/routes/main/knowledge"]) {
    assert.equal(showsRouteSwitcher(route), true, route);
  }
  for (const route of ["/overview", "/routes/main/overview", "/speech", "/routes/main/speech", "/runtime", "/routes/main/runtime", "/performance", "/settings", "/video", "/lan-agents", "/docs", "/routes/main/unknown"]) {
    assert.equal(showsRouteSwitcher(route), false, route);
  }
});

test("one conditional selector follows the title in the top bar and reuses gateway selection", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const app = fs.readFileSync(path.join(root, "src/App.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");
  const sidebar = app.slice(app.indexOf("<v-navigation-drawer"), app.indexOf("</v-navigation-drawer>"));
  const topbar = app.slice(app.indexOf("<v-app-bar flat"), app.indexOf("</v-app-bar>"));
  assert.doesNotMatch(sidebar, /<v-select|route-picker/);
  assert.equal((app.match(/<v-select\b/g) || []).length, 1);
  assert.match(topbar, /<v-toolbar-title[\s\S]*?<\/v-toolbar-title>[\s\S]*?<v-select[\s\S]*?v-if="showRouteSwitcher"/);
  assert.match(app, /computed\(\(\) => showsRouteSwitcher\(route.path\)\)/);
  assert.match(topbar, /:model-value="store.selectedGatewayId"/);
  assert.match(topbar, /:items="routeOptions"/);
  assert.match(topbar, /@update:model-value="value => selectGateway\(String\(value \|\| ''\)\)"/);
  assert.match(styles, /\.topbar-context\.has-route-switcher\s*\{[^}]*flex-direction: column/);
  assert.doesNotMatch(styles, /(?:^|\n)\.route-picker\s*\{/);
});
