import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { VideoError } from "./service.mjs";

const folders = { diffusion: "diffusion_models", textEncoder: "text_encoders", vae: "vae", lora: "loras" };
export async function safeTarget(root, relative) {
  const base = path.resolve(root), target = path.resolve(base, relative);
  const inside = path.relative(base, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new VideoError("模型文件路径无效。");
  // Reject junctions at every existing level, including partial files and the root.
  for (let current = target; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat?.isSymbolicLink()) throw new VideoError("模型目录不能包含符号链接或目录联接。");
    if (path.dirname(current) === current) break;
  }
  return target;
}
async function validSize(file, bytes) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== bytes) return false;
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(9); await handle.read(header, 0, 9, 0);
      const length = Number(header.readBigUInt64LE());
      return length > 2 && length < Math.min(bytes - 8, 100 * 1024 * 1024) && header[8] === 123;
    } finally { await handle.close(); }
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export async function downloadFile(url, target, bytes, sha256, signal, progress, fetcher = fetch) {
  const partial = `${target}.part`;
  const base = path.dirname(target);
  await safeTarget(base, path.basename(partial));
  await fs.mkdir(base, { recursive: true });
  // Exclusive creation preserves incomplete and unknown existing files on retry.
  const temporary = `${partial}.${randomUUID()}`;
  const handle = await fs.open(temporary, "wx");
  let count = 0;
  const hash = createHash("sha256");
  try {
    let response;
    for (let redirect = 0; redirect < 6; redirect++) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
        !(parsed.hostname === "huggingface.co" || parsed.hostname.endsWith(".hf.co") || parsed.hostname.endsWith(".huggingface.co"))) throw new VideoError("模型下载地址不受信任。");
      response = await fetcher(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(4 * 60 * 60 * 1000)]) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = response.headers.get("location"); await response.body?.cancel();
      if (!next) throw new VideoError("模型下载重定向无效。");
      url = new URL(next, url).href;
    }
    if (!response?.ok || !response.body) throw new VideoError("模型下载失败，请稍后重试。");
    for await (const chunk of response.body) {
      signal.throwIfAborted(); count += chunk.length;
      if (count > bytes) throw new VideoError("模型下载大小超出清单。");
      hash.update(chunk); await handle.writeFile(chunk); progress(count);
    }
    if (count !== bytes || hash.digest("hex") !== sha256) throw new VideoError("模型大小或 SHA-256 校验失败。");
    await handle.sync(); await handle.close();
    await safeTarget(base, path.basename(target));
    // Hard-link publication is atomic and refuses to overwrite an existing model.
    await fs.link(temporary, target); await fs.unlink(temporary);
  } finally { await handle.close().catch(() => {}); }
}

export class VideoModels {
  constructor(runtime, catalog, publish) {
    this.runtime = runtime; this.catalog = catalog; this.publish = publish;
    this.file = path.join(runtime.stateRoot, "model-directory.json");
    this.settings = { revision: 0, modelRoot: null }; this.job = null; this.flight = null;
    this.controller = new AbortController(); this.closed = false;
  }
  async initialize() {
    const text = await fs.readFile(this.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (text) {
      const value = JSON.parse(text);
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.modelRoot === null || typeof value.modelRoot === "string")) throw new Error("Invalid video model settings");
      this.settings = value;
    }
  }
  root() { return this.settings.modelRoot || this.runtime.defaultModelRoot; }
  directories() { return { ...this.settings, effectiveModelRoot: this.root(), defaultModelRoot: this.runtime.defaultModelRoot }; }
  guard() {
    if (this.runtime.readOnly) throw new VideoError("只读模式下不能安装或配置模型。", 423);
    if (this.closed || this.flight || this.runtime.alive()) throw new VideoError("请先停止视频服务并等待安装结束。", 409);
  }
  async configure(body) {
    this.guard();
    if (!body || Object.keys(body).some(key => !["modelRoot", "expectedRevision"].includes(key)) || body.expectedRevision !== this.settings.revision || !("modelRoot" in body)) throw new VideoError("目录设置已改变，请刷新后重试。", 409);
    const modelRoot = await this.runtime.validateModelRoot(body.modelRoot);
    if (modelRoot) await safeTarget(modelRoot, "model-directory-check");
    this.guard();
    const target = { revision: this.settings.revision + 1, modelRoot };
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(target), { flag: "wx" });
    await fs.rename(temp, this.file); this.settings = target;
    return this.directories();
  }
  async snapshot() {
    const models = await Promise.all(this.catalog.models.map(async model => {
      const files = await Promise.all(Object.entries(model.files).map(async ([key, name]) => {
        const target = await safeTarget(this.root(), path.join(folders[key], name));
        return { name, bytes: model.expectedBytes[key], installed: await validSize(target, model.expectedBytes[key]) };
      }));
      return { id: model.id, label: model.label, files, installed: files.every(file => file.installed), bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
    }));
    return { runtimeInstalled: await this.runtime.installed(), models, job: this.job };
  }
  begin(kind, operation) {
    this.guard(); this.job = { kind, state: "running", bytes: 0, total: 0 };
    this.flight = Promise.resolve().then(operation).then(() => { this.job.state = "completed"; }, () => { this.job.state = "failed"; this.job.message = "安装未完成，请检查视频安装日志或网络后重试。已有模型和未完成下载均已保留。"; }).finally(() => { this.flight = null; this.publish(); });
    this.publish(); return this.job;
  }
  installRuntime() { return this.begin("runtime", () => this.runtime.install()); }
  download(id) {
    const model = this.catalog.models.find(row => row.id === id);
    if (!model) throw new VideoError("未知视频模型。");
    return this.begin("model", async () => {
      if (!await this.runtime.installed()) throw new VideoError("请先安装视频运行环境。", 409);
      await this.runtime.validateModelRoot(this.root());
      this.job.total = Object.values(model.expectedBytes).reduce((sum, bytes) => sum + bytes, 0);
      let completed = 0, lastEvent = 0;
      for (const [key, name] of Object.entries(model.files)) {
        const relative = path.join(folders[key], name);
        const target = await safeTarget(this.root(), relative);
        const bytes = model.expectedBytes[key];
        if (!await validSize(target, bytes)) {
          if (await fs.lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; })) throw new VideoError("已有模型文件不完整，请保留并人工检查后重试。");
          await downloadFile(`https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/${folders[key]}/${name}`, target, bytes, model.sha256[key], this.controller.signal, count => {
            this.job.bytes = completed + count;
            if (Date.now() - lastEvent > 1000) { lastEvent = Date.now(); this.publish(); }
          });
        }
        completed += bytes; this.job.bytes = completed; this.publish();
      }
    });
  }
  async close() { this.closed = true; this.controller.abort(); await this.runtime.stopInstaller(); await this.flight; }
}
