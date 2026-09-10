import type { DesktopPetBinding } from "@shared/desktopSettingsContract";

export type DesktopPetPackSummary = {
  id: string;
  name: string;
  personaId: string;
  states: Record<string, DesktopPetAnimation>;
  idleBehavior?: { randomStates: string[]; sleepState?: string };
};

export type DesktopPetAnimation = {
  type: "gif" | "png-sequence";
  assets: string[];
  fps: number;
  loop: boolean;
  next?: string;
};

async function responseData<T>(response: Response): Promise<T> {
  const payload = await response.json() as { code?: number; data?: T; message?: string };
  if (!response.ok || payload.code !== 0 || payload.data === undefined) {
    throw new Error(payload.message || `Manager 请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

export const desktopPetClient = {
  async binding(personaId: string): Promise<DesktopPetBinding> {
    const response = await fetch(`/api/desktop-pet/roles/${encodeURIComponent(personaId)}`);
    return (await responseData<{ personaId: string; binding: DesktopPetBinding }>(response)).binding;
  },

  async packs(personaId: string): Promise<{ packs: DesktopPetPackSummary[]; diagnostics: Array<{ packId: string; message: string }> }> {
    const response = await fetch(`/api/desktop-pet/roles/${encodeURIComponent(personaId)}/packs`);
    return responseData(response);
  },

  async update(personaId: string, binding: Partial<DesktopPetBinding>): Promise<DesktopPetBinding> {
    const response = await fetch(`/api/desktop-pet/roles/${encodeURIComponent(personaId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId, ...binding })
    });
    return (await responseData<{ personaId: string; binding: DesktopPetBinding }>(response)).binding;
  },

  async importFile(personaId: string, file: File, options: { packId: string; state: string; name: string }): Promise<DesktopPetPackSummary> {
    const query = new URLSearchParams({ fileName: file.name, ...options });
    const response = await fetch(`/api/desktop-pet/roles/${encodeURIComponent(personaId)}/packs/import?${query}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-rabi-file-name": file.name },
      body: file
    });
    return (await responseData<{ personaId: string; pack: DesktopPetPackSummary }>(response)).pack;
  }
};
