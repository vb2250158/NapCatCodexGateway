import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function requestHook(input, options = {}) {
  const env = options.env ?? process.env;
  let descriptor;
  let baseUrl = env.RABI_MANAGER_URL;
  if (!baseUrl) {
    const host = env.RABIROUTE_HOST_EXE || (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'RabiRoute', 'RabiRouteHost.exe'));
    if (!host) throw new Error('RabiRoute Host is unavailable.');
    const { stdout } = await (options.execute ?? execute)(host, ['--command', 'status', '--json'], { windowsHide: true, timeout: 3000 });
    descriptor = JSON.parse(stdout);
    baseUrl = descriptor.managerBaseUrl;
  }
  if (!baseUrl) throw new Error('RabiRoute Host has no active Manager.');
  baseUrl = String(baseUrl).replace(/\/+$/, '');
  const fetcher = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(8000);
  const response = await fetcher(`${baseUrl}/meta`, { signal });
  const meta = await response.json();
  if (!response.ok || meta.health?.state !== 'healthy' || meta.health?.requiredReady !== true
      || (descriptor && (meta.applicationGenerationId !== descriptor.applicationGenerationId || meta.managerInstanceId !== descriptor.managerInstanceId))) {
    throw new Error('RabiRoute Manager generation is not ready.');
  }
  const result = await fetcher(`${baseUrl}/api/codex-hook/context`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal
  });
  const body = await result.json();
  if (!result.ok || body.code !== 0) throw new Error(body.message || 'RabiRoute Hook failed.');
  return body.data;
}
