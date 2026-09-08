import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateModelRoot } from "./speechModelSettings.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import type { ProcessLease, ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";

async function validateLocalModelRoot(value: unknown) {
  const root = validateModelRoot(value, [], () => true);
  if (!root) return null;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$d=Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $env:RABIROUTE_VIDEO_MODEL_DRIVE + [char]39); if($d.DriveType -eq 3){'fixed'}"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true, env: { ...process.env, RABIROUTE_VIDEO_MODEL_DRIVE: root.slice(0, 2) } });
  if (stdout.trim() !== "fixed") throw new Error("Video models require a local fixed disk");
  return root;
}

/** Only the installed, fixed video component can be launched; API callers never supply commands. */
export function createVideoRuntime(rootDir: string, identity: PluginIdentity, leases: ProcessLeaseRegistry, readOnly = false) {
  const componentRoot = path.join(rootDir, "components", "video");
  const comfyRoot = path.join(componentRoot, "ComfyUI");
  let lease: ProcessLease | undefined;
  let endpoint = "";
  let starting: Promise<string> | undefined;
  let installer: ProcessLease | undefined;
  const exitListeners = new Set<() => void>();
  async function start(modelRoot?: string): Promise<string> {
    if (readOnly) throw new Error("视频服务在只读模式下不能启动。");
    if (lease && lease.child.exitCode === null && endpoint) return endpoint;
    if (starting) return starting;
    starting = (async () => {
      const settings = JSON.parse(await fs.readFile(path.join(componentRoot, "runtime.json"), "utf8").catch(() => "{}")) as { pythonExecutable?: string };
      const python = settings.pythonExecutable || path.join(componentRoot, ".venv", "Scripts", "python.exe");
      if (!path.isAbsolute(python) || python.startsWith("\\\\") || path.basename(python).toLowerCase() !== "python.exe") throw new Error("视频 Python 运行环境无效，请重新运行安装脚本。");
      for (const target of [python, path.join(comfyRoot, "main.py")]) {
        try { await fs.access(target); } catch { throw new Error("视频运行环境尚未安装，请先运行视频插件的 Install-RabiVideo.ps1。"); }
      }
      const realRoot = await fs.realpath(componentRoot);
      if (realRoot.startsWith("\\\\")) throw new Error("视频运行环境必须安装在本机磁盘。");
      const modelArguments: string[] = [];
      if (modelRoot) {
        await validateLocalModelRoot(modelRoot);
        const config = path.join(componentRoot, "model-paths.json");
        // JSON is a YAML subset; paths are never interpolated into YAML or a command.
        await fs.writeFile(config, JSON.stringify({ rabi_video: { base_path: modelRoot, is_default: true, diffusion_models: "diffusion_models", text_encoders: "text_encoders", vae: "vae", loras: "loras" } }));
        modelArguments.push("--extra-model-paths-config", config);
      }
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") { server.close(); reject(new Error("无法分配视频服务端口。")); return; }
          server.close(error => error ? reject(error) : resolve(address.port));
        });
      });
      const output = path.join(rootDir, "data", "video", "provider-output");
      const input = path.join(rootDir, "data", "video", "provider-input");
      const logs = path.join(rootDir, "logs", "video");
      await Promise.all([output, input, logs].map(directory => fs.mkdir(directory, { recursive: true })));
      const log = await fs.open(path.join(logs, `comfy-${Date.now()}.log`), "a");
      try {
        lease = leases.launch(identity, "video-comfyui", () => spawn(python, [
          "-u", path.join(comfyRoot, "main.py"), "--listen", "127.0.0.1", "--port", String(port),
          "--input-directory", input, "--output-directory", output, "--disable-auto-launch", ...modelArguments
        ], { cwd: comfyRoot, windowsHide: true, stdio: ["ignore", log.fd, log.fd] }),
        { maxChildProcesses: 1, exclusiveAcrossOwners: true });
        void lease.settled.then(() => { for (const listener of exitListeners) listener(); });
      } finally { await log.close(); }
      endpoint = `http://127.0.0.1:${port}`;
      return endpoint;
    })().finally(() => { starting = undefined; });
    return starting;
  }
  return Object.freeze({
    stateRoot: path.join(rootDir, "data", "video"),
    readOnly,
    componentRoot,
    defaultModelRoot: path.join(comfyRoot, "models"),
    localSettingsAllowed: localModelSettingsRequestAllowed,
    validateModelRoot: validateLocalModelRoot,
    async installed() {
      const settings = JSON.parse(await fs.readFile(path.join(componentRoot, "runtime.json"), "utf8").catch(() => "{}")) as { pythonExecutable?: string };
      return Promise.all([settings.pythonExecutable || path.join(componentRoot, ".venv", "Scripts", "python.exe"), path.join(comfyRoot, "main.py")].map(file => fs.access(file).then(() => true, () => false))).then(values => values.every(Boolean));
    },
    async install() {
      if (readOnly || installer || lease?.child.exitCode === null) throw new Error("Video runtime is busy or read-only");
      const script = path.join(componentRoot, "install-runtime.ps1");
      // The plugin writes only its bundled installer to this fixed component location.
      const logs = path.join(rootDir, "logs", "video");
      await fs.mkdir(logs, { recursive: true });
      const log = await fs.open(path.join(logs, `install-${Date.now()}.log`), "a");
      try {
        installer = leases.launch(identity, "video-installer", () => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-ComponentRoot", componentRoot], { cwd: componentRoot, windowsHide: true, stdio: ["ignore", log.fd, log.fd] }), { maxChildProcesses: 1, exclusiveAcrossOwners: true });
        await installer.settled;
        if (installer.child.exitCode !== 0) throw new Error("Video runtime installation failed");
      } finally { installer = undefined; await log.close(); }
    },
    async stopInstaller() { if (installer) await leases.terminate(installer); },
    start,
    alive: () => Boolean(lease && lease.child.exitCode === null),
    onExit(listener: () => void) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    async stop() {
      await starting?.catch(() => {});
      if (lease) await leases.terminate(lease);
      lease = undefined;
      endpoint = "";
    }
  });
}
