import { scanAgentAdapters, scanDshAgentAdapter } from "./managerApi.js";
import { handleAgentThreadRequest, type AgentThreadRequest } from "../agentThreads.js";
import { updateAgentHooks } from "./hookInstallation.js";

export type InstanceManagementContext = { rootDir: string; defaultWorkspace: string; allowedWorkspaces: string[]; dsh?: { baseUrl: string } };

/** Both transports execute the same provider operations on the owning computer. */
export async function manageInstanceAgent(operation: string, params: Record<string, unknown>, context: InstanceManagementContext): Promise<unknown> {
  const dshBaseUrl = context.dsh?.baseUrl;
  if (operation === "scan") {
    const scanContext = { rootDir: context.rootDir, cwdOptions: context.allowedWorkspaces };
    return params.provider === "dsh"
      ? scanDshAgentAdapter(scanContext, { dshBaseUrl })
      : scanAgentAdapters(scanContext, { dshBaseUrl });
  }
  if (operation === "threads") {
    return handleAgentThreadRequest({ ...params, dshBaseUrl } as AgentThreadRequest, {
      allowedWorkspaces: context.allowedWorkspaces,
      defaultWorkspace: context.defaultWorkspace,
      dshBaseUrl
    });
  }
  if (operation === "hooks") return updateAgentHooks(context.rootDir, String(params.provider || ""));
  throw new Error("Unsupported instance Agent operation.");
}
