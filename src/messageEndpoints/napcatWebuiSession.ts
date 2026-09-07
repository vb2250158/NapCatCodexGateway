import { createHash } from "node:crypto";

export type NapcatWebuiSession = {
  baseUrl: string;
  request(pathname: string, body?: Record<string, unknown>): Promise<Response>;
};
type Credential = { value: string; expiresAt: number };

/** Management credentials are private connection state, never QQ login state. */
export class NapcatWebuiSessions {
  private credentials = new Map<string, Credential>();
  private flights = new Map<string, Promise<Credential | null>>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  async open(baseUrl: string, token: string): Promise<NapcatWebuiSession | null> {
    const hash = createHash("sha256").update(`${token}.napcat`).digest("hex");
    const key = JSON.stringify([baseUrl, hash]);
    const authorize = (): Promise<Credential | null> => {
      const cached = this.credentials.get(key);
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
      const pending = this.flights.get(key);
      if (pending) return pending;
      const flight = (async () => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ hash }), signal: AbortSignal.timeout(5000)
        });
        const result = await response.json().catch(() => ({})) as { code?: number; data?: { Credential?: string } };
        const value = String(result.data?.Credential || "").trim();
        if (!response.ok || result.code !== 0 || !value) return null;
        for (const [oldKey, item] of this.credentials) if (item.expiresAt <= Date.now()) this.credentials.delete(oldKey);
        if (this.credentials.size >= 64) this.credentials.delete(this.credentials.keys().next().value!);
        const credential = { value, expiresAt: Date.now() + this.ttlMs };
        this.credentials.set(key, credential);
        return credential;
      })().finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
      this.flights.set(key, flight);
      return flight;
    };
    const invalidate = (credential: Credential) => {
      if (this.credentials.get(key) === credential) this.credentials.delete(key);
    };
    if (!await authorize()) return null;
    return {
      baseUrl,
      request: async (pathname, body = {}) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const credential = await authorize();
          if (!credential) throw new Error("NapCat 管理服务暂时无法认证；请确认后台已启动并能读取 WebUI 登录密钥。");
          let response: Response;
          try {
            response = await fetch(`${baseUrl}${pathname}`, {
              method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${credential.value}` },
              body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
            });
          } catch (error) { invalidate(credential); throw error; }
          const result = await response.clone().json().catch(() => ({})) as { code?: number; message?: string };
          const unauthorized = response.status === 401 || (result.code !== 0 && /unauthorized|credential.*(?:invalid|expired)/i.test(String(result.message || "")));
          if (!unauthorized) return response;
          invalidate(credential);
          // Authentication rejection precedes execution; ordinary action failures are never retried.
          if (attempt === 1) return response;
        }
        throw new Error("NapCat management authentication failed.");
      }
    };
  }
}
