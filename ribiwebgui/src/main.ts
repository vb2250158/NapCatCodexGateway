import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import "./styles.css";

import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { installDomLocalizer } from "./i18n/domLocalizer";
import { installManagerFetchPrefix } from "./managerApi";
import {
  installFrontendPerformanceReporter,
  recordFrontendPerformanceOperation
} from "./performance/frontendPerformanceReporter";
import { webguiRouteRenderOperation } from "@shared/performanceOperations";
import { lazyRouteRecovery, router } from "./router";
import { vuetify } from "./plugins/vuetify";
import { redirectLoopbackWebguiToLan } from "./webguiLanRedirect";
import { pluginCatalogStore } from "./pluginCatalogStore";
import { refreshWebPluginModulesSafely } from "./pluginModuleBootstrap";

let routeRenderStartedAt = performance.now();
router.beforeEach(() => {
  routeRenderStartedAt = performance.now();
});
router.afterEach((to) => {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    recordFrontendPerformanceOperation(
      webguiRouteRenderOperation(to.path),
      performance.now() - routeRenderStartedAt
    );
  }));
});
router.onError((error, target) => {
  lazyRouteRecovery.recover(error, target.fullPath);
});

export async function refreshWebPluginCatalogInBackground(): Promise<void> {
  await pluginCatalogStore.refresh();
  await refreshWebPluginModulesSafely();
}

async function bootstrap(): Promise<void> {
  installManagerFetchPrefix();
  installFrontendPerformanceReporter();
  if (await redirectLoopbackWebguiToLan()) return;

  const app = createApp(App)
    .use(createPinia())
    .use(router)
    .use(vuetify);

  await router.isReady();
  app.mount("#app");

  installDomLocalizer();
  void refreshWebPluginCatalogInBackground();
}

void bootstrap();
