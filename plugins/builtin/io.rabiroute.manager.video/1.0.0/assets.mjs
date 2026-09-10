import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VideoError } from "./service.mjs";
import { safeTarget } from "./models.mjs";
export const assetTypes = { image: { extension: "png", mime: "image/png", maxBytes: 9 * 1024 ** 2 }, video: { extension: "mp4", mime: "video/mp4", maxBytes: 64 * 1024 ** 2 }, audio: { extension: "wav", mime: "audio/wav", maxBytes: 16 * 1024 ** 2 } };
export class VideoAssets {
  constructor(runtime) { this.runtime = runtime; this.root = path.join(runtime.stateRoot, "assets"); this.pending = false; this.closed = false; }
  async read(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new VideoError("素材编号无效。");
    const file = await safeTarget(this.root, `${id}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf8").catch(() => { throw new VideoError("参考素材不存在，请重新上传。", 404); }));
    if (record.id !== id || !Object.hasOwn(assetTypes, record.kind)) throw new VideoError("素材记录无效。");
    return record;
  }
  async file(id) { const record = await this.read(id); return { record, file: await safeTarget(this.root, `${id}.${assetTypes[record.kind].extension}`) }; }
  async upload(request, kind) {
    const type = Object.hasOwn(assetTypes, kind) ? assetTypes[kind] : undefined;
    if (!type) throw new VideoError("不支持的参考素材类型。");
    if (this.runtime.readOnly || this.closed) throw new VideoError("素材服务只读或正在关闭。", 423);
    if (this.pending) throw new VideoError("请等待当前素材检查完成。", 409);
    if (Number(request.headers["content-length"]) > type.maxBytes) throw new VideoError("参考素材文件过大。", 413);
    this.pending = true;
    try {
      if (this.runtime.installed && !await this.runtime.installed()) throw new VideoError("请先在模型管理中安装视频运行环境，再上传参考素材。", 409);
      await fs.mkdir(this.root, { recursive: true });
      const id = randomUUID(), file = await safeTarget(this.root, `${id}.${type.extension}`);
      const handle = await fs.open(file, "wx"); let size = 0;
      const timer = setTimeout(() => request.destroy(), 120000);
      try { for await (const chunk of request) { size += chunk.length; if (size > type.maxBytes) throw new VideoError("参考素材文件过大。", 413); await handle.writeFile(chunk); } }
      finally { clearTimeout(timer); await handle.close(); }
      if (!size || this.closed) throw new VideoError("素材上传未完成。");
      let metadata;
      try { metadata = await this.runtime.inspectAsset(id, kind); }
      catch { throw new VideoError("素材无法解码或超出限制，请检查格式、尺寸、帧率和时长。", 422); }
      if (this.closed) throw new VideoError("素材服务正在关闭。", 503);
      const record = { id, kind, size, ...metadata };
      await fs.writeFile(await safeTarget(this.root, `${id}.json`), JSON.stringify(record), { flag: "wx" });
      return record;
    } finally { this.pending = false; }
  }
}
