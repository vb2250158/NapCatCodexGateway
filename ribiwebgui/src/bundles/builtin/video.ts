import type { TrustedWebPageRegistration } from "../../pluginPages";

type Api = { instanceIds: readonly string[]; forInstance(id: string): { registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void } };
export function activate(api: Api): () => void {
  const disposers = api.instanceIds.map(id => api.forInstance(id).registerPage({
    routeId: "global.video", rendererId: "builtin.web-page.video.v1",
    loader: () => import("../../pages/VideoPage.vue"),
    paths: [{ path: "/video", title: "视频生成" }],
    navigation: { resolvePath: () => "/video", allowedSlots: ["utility"], allowedIcons: ["mdi-video-outline"] }
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
