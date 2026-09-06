import type { SpeechModelManagementSnapshot, SpeechModelDirectorySettings, SpeechModelDirectorySettingsPatch } from "@shared/speechModelManagement";

type ManagerEnvelope<T> = {
  code: number;
  data?: T;
  message?: string;
};

export class SpeechModelManagementRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let body: ManagerEnvelope<T>;
  try {
    body = JSON.parse(text) as ManagerEnvelope<T>;
  } catch {
    throw new SpeechModelManagementRequestError(`HTTP ${response.status}`, response.status);
  }
  if (!response.ok || body.code !== 0 || !body.data) {
    throw new SpeechModelManagementRequestError(body.message || `HTTP ${response.status}`, response.status);
  }
  return body.data;
}

async function updateDirectorySettings(patch: SpeechModelDirectorySettingsPatch): Promise<SpeechModelDirectorySettings> {
  const response = await fetch("/meta", { headers: { accept: "application/json" } });
  const meta = await response.json() as { applicationGenerationId?: string; managerInstanceId?: string };
  const applicationGenerationId = String(meta.applicationGenerationId || "").trim();
  const managerInstanceId = String(meta.managerInstanceId || "").trim();
  if (!response.ok || !applicationGenerationId || !managerInstanceId) {
    throw new Error("Manager lifecycle identity is unavailable; reload WebGUI after Host reports READY.");
  }
  return request("/api/speech/model-management/settings", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-rabiroute-expected-application-generation-id": applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": managerInstanceId
    },
    body: JSON.stringify(patch)
  });
}

export const speechModelManagementClient = {
  directorySettings: (): Promise<SpeechModelDirectorySettings> => request("/api/speech/model-management/settings"),
  updateDirectorySettings,
  snapshot: (): Promise<SpeechModelManagementSnapshot> => request("/api/speech/model-management"),
  installRuntime: (): Promise<SpeechModelManagementSnapshot> => request(
    "/api/speech/model-management/runtime/install",
    { method: "POST" }
  ),
  installModel: (alias: string): Promise<SpeechModelManagementSnapshot> => request(
    `/api/speech/model-management/models/${encodeURIComponent(alias)}/install`,
    { method: "POST" }
  )
};
