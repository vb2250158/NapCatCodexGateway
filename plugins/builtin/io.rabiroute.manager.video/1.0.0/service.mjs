import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildWorkflow, validateCommand, resolveWorkflow } from "./workflow.mjs";

export class VideoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class VideoService {
  constructor(runtime, catalog, publish, dependencies = {}) {
    this.runtime = runtime;
    this.catalog = catalog;
    this.publish = publish;
    this.fetch = dependencies.fetch ?? fetch;
    this.WebSocket = dependencies.WebSocket ?? WebSocket;
    this.jobs = new Map();
    this.endpoint = "";
    this.online = false;
    this.closing = false;
    this.active = undefined;
    this.serial = Promise.resolve();
    this.controller = new AbortController();
    this.unsubscribeExit = runtime.onExit?.(() => { this.online = false; this.publish("video.changed", { online: false }); });
  }
  exclusive(action) {
    const next = this.serial.then(action);
    this.serial = next.catch(() => {});
    return next;
  }
  async initialize() {
    if (!this.runtime.readOnly) await fs.mkdir(path.join(this.runtime.stateRoot, "jobs"), { recursive: true });
    const files = await fs.readdir(path.join(this.runtime.stateRoot, "jobs")).catch(error => { if (error.code === "ENOENT" && this.runtime.readOnly) return []; throw error; });
    for (const file of files) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const job = JSON.parse(await fs.readFile(path.join(this.runtime.stateRoot, "jobs", file), "utf8"));
      if (file !== `${job.id}.json` || !this.catalog.states[job.status]) throw new Error("视频任务记录无效，已停止加载。");
      if (!this.runtime.readOnly && !this.catalog.states[job.status].terminal) {
        job.status = "interrupted";
        job.error = "服务重启，任务未自动重试。";
        await this.save(job);
      }
      this.jobs.set(job.id, job);
    }
  }
  async save(job) {
    if (this.runtime.readOnly) throw new VideoError("只读模式下不能修改视频任务。", 423);
    job.updatedAt = new Date().toISOString();
    const target = path.join(this.runtime.stateRoot, "jobs", `${job.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(job), { flag: "wx" });
    await fs.rename(temporary, target);
    this.publish("video.changed", { jobId: job.id, status: job.status });
  }
  view(job) {
    const { keyHash, commandHash, firstFrame, lastFrame, output, ...value } = job;
    const image = this.catalog.models.find(row=>row.id===job.model)?.mode === "image";
    return { ...value, mediaKind: image ? "image" : "video", imageUrl: image && job.status === "succeeded" ? `/api/video/jobs/${job.id}/image` : undefined, hasFirstFrame: Boolean(firstFrame), hasLastFrame: Boolean(lastFrame), videoUrl: !image && job.status === "succeeded" ? `/api/video/jobs/${job.id}/video` : undefined };
  }
  snapshot() {
    return { online: this.online && this.runtime.alive(), availableModels: this.availableModels || [], availableWorkflows: this.availableWorkflows || [], models: this.catalog.models, states: this.catalog.states,
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(job => this.view(job)) };
  }
  async request(route, init = {}) {
    const response = await this.fetch(`${this.endpoint}${route}`, { ...init, redirect: "error", signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw new VideoError(`H3 服务请求失败（HTTP ${response.status}）。`, 502);
    return response.json();
  }
  async start(modelRoot, beforeStart = () => {}) {
    return this.exclusive(async () => {
      await beforeStart();
      if (this.closing) throw new VideoError("视频插件正在停止。", 503);
      if (this.online && this.runtime.alive()) return this.snapshot();
      this.endpoint = await this.runtime.start(typeof modelRoot === "function" ? modelRoot() : modelRoot);
      try {
        const deadline = Date.now() + 120000;
        while (true) {
          if (!this.runtime.alive()) throw new VideoError("H3 进程已退出，请检查视频服务日志。", 503);
          try { await this.request("/system_stats"); break; } catch (error) {
            if (Date.now() >= deadline || this.closing) throw error;
            await delay(1000, undefined, { signal: this.controller.signal });
          }
        }
        const info = await this.request("/object_info");
        this.availableModels=[];
        this.availableWorkflows=[];
        for (const model of this.catalog.models) {
          for (const workflowId of model.workflows ? Object.keys(model.workflows) : [undefined]) {
            for (const generateAudio of model.mode === "image" ? [false] : [false, true]) {
              const command = { id:"check", prompt:"check", width:512, height:512, frames:22, seed:1, workflowId, generateAudio };
              const workflow = buildWorkflow(model, command);
              const resolved = resolveWorkflow(model, command);
              if (Object.values(workflow).some(node => !info[node.class_type])) continue;
              const files = [["UNETLoader","unet_name",resolved.files.diffusion],["CLIPLoader","clip_name",resolved.files.textEncoder],["VAELoader","vae_name",resolved.files.vae],["VAELoader","vae_name",resolved.files.audioVae],["LoraLoaderModelOnly","lora_name",resolved.files.lora]].filter(row=>row[2]);
              if (!files.every(([node,field,file])=>info[node]?.input?.required?.[field]?.[0]?.includes(file))) continue;
              this.availableWorkflows.push({model:model.id, workflowId:resolved.workflowId, generateAudio});
              if (!this.availableModels.includes(model.id)) this.availableModels.push(model.id);
            }
          }
        }
        if(!this.availableModels.length) throw new VideoError("没有已安装完整的生成模型，请打开模型管理。",409);
        this.online = true;
        this.publish("video.changed", { online: true });
        return this.snapshot();
      } catch (error) { await this.runtime.stop(); this.endpoint = ""; this.online = false; throw error; }
    });
  }
  async stop() {
    return this.exclusive(async () => {
      if ([...this.jobs.values()].some(job => !this.catalog.states[job.status].terminal)) throw new VideoError("仍有生成任务，请等待完成或取消排队任务。", 409);
      await this.runtime.stop();
      this.endpoint = "";
      this.online = false;
      this.publish("video.changed", { online: false });
      return this.snapshot();
    });
  }
  async submit(input, key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new VideoError("请提供 8–128 字符的 Idempotency-Key。");
    let command;
    try { command = validateCommand(input, this.catalog); } catch (error) { throw new VideoError(error.message); }
    const hash = value => createHash("sha256").update(value).digest("hex");
    const keyHash = hash(key), commandHash = hash(JSON.stringify(command));
    return this.exclusive(async () => {
      const previous = [...this.jobs.values()].find(job => job.keyHash === keyHash);
      if (previous) {
        if (previous.commandHash !== commandHash) throw new VideoError("同一个幂等键已用于不同参数。", 409);
        return this.view(previous);
      }
      if (this.closing || !this.online || !this.runtime.alive()) throw new VideoError("请先启动视频生成服务。", 503);
      if(this.availableModels && !this.availableModels.includes(command.model)) throw new VideoError("所选模式的模型尚未安装，请打开模型管理。",409);
      let resolved;
      const routingCommand = {...command};

      if(command.references) {
        const references=await Promise.all(command.references.map(id=>this.assets.read(id)));
        routingCommand.referenceKinds = references.map(asset=>asset.kind);
        for(const [kind,limit] of [["image",9],["video",3],["audio",3]]) if(references.filter(a=>a.kind===kind).length>limit) throw new VideoError("参考素材数量超出模式限制。");
      }
      try { resolved = resolveWorkflow(this.catalog.models.find(model=>model.id===command.model), routingCommand, this.availableWorkflows); }
      catch(error) { throw new VideoError(error.message,409); }
      if (this.availableWorkflows && !this.availableWorkflows.some(row=>row.model===command.model && row.workflowId===resolved.workflowId && row.generateAudio===!!command.generateAudio)) throw new VideoError("工作流依赖尚未就绪。",409);
      if ([...this.jobs.values()].filter(job => !this.catalog.states[job.status].terminal).length >= 8) throw new VideoError("生成队列已满，最多接受 8 个待完成任务。", 429);
      const job = { ...command, workflowId: resolved.workflowId, samplingSteps: resolved.steps, id: randomUUID(), keyHash, commandHash, status: "queued", createdAt: new Date().toISOString(), progress: 0 };
      await this.save(job);
      this.jobs.set(job.id, job);
      this.pump();
      return this.view(job);
    });
  }
  async cancel(id) {
    return this.exclusive(async () => {
      const job = this.jobs.get(id);
      if (!job) throw new VideoError("任务不存在。", 404);
      if (job.status !== "queued") throw new VideoError("只能取消尚未开始的任务。", 409);
      job.status = "cancelled";
      await this.save(job);
      return this.view(job);
    });
  }
  pump() {
    if (this.active || this.closing) return;
    this.active = this.runQueue().finally(() => { this.active = undefined; });
    // Observe persistence failures too; never leave an unhandled background promise.
    this.active.catch(() => { this.online = false; this.publish("video.changed", { online: false, error: "任务记录写入失败，请检查磁盘后重启服务。" }); });
  }
  async runQueue() {
    while (!this.closing) {
      const job = await this.exclusive(async () => {
        const next = [...this.jobs.values()].find(item => item.status === "queued");
        if (next) { next.status = "running"; await this.save(next); }
        return next;
      });
      if (!job) return;
      try {
        const model = this.catalog.models.find(item => item.id === job.model);
        const images = [];
        for (const field of ["firstFrame", "lastFrame"]) {
          if (!job[field]) { images.push(undefined); continue; }
          const name = `${job.id}-${field}.png`;
          const form = new FormData();
          form.append("image", new Blob([Buffer.from(job[field], "base64")], { type: "image/png" }), name);
          const uploaded = await this.request("/upload/image", { method: "POST", body: form });
          if (uploaded.name !== name || uploaded.subfolder) throw new VideoError("H3 图片上传回执不匹配。", 502);
          images.push(name);
        }
        const references=[];
        for(const id of job.references || []) {
          const {record,file}=await this.assets.file(id);
          const name=path.basename(file);
          const form=new FormData(); form.append("image",new Blob([await fs.readFile(file)]),name);
          const uploaded=await this.request("/upload/image",{method:"POST",body:form});
          if(uploaded.name!==name || uploaded.subfolder) throw new VideoError("参考素材上传回执不匹配。",502);
          references.push({...record,filename:name});
        }
        const history = await this.generate(job, buildWorkflow(model, job, ...images, references));
        const isImage = model.mode === "image";
        const output = Object.values(history.outputs ?? {}).flatMap(node => [...(node.images ?? []), ...(node.videos ?? [])]).find(item => item.type === "output" && item.filename?.endsWith(isImage ? ".png" : ".mp4"));
        if (!output) throw new VideoError("生成服务未返回预期格式的文件。", 502);
        job.output = { filename: output.filename, subfolder: output.subfolder || "" };
        const file = await this.outputPath(job);
        const handle = await fs.open(file, "r");
        try {
          const signature = Buffer.alloc(12);
          const { bytesRead } = await handle.read(signature, 0, 12, 0);
          if (bytesRead !== 12 || (isImage ? signature.subarray(0,8).toString("hex") !== "89504e470d0a1a0a" : signature.toString("ascii", 4, 8) !== "ftyp")) throw new VideoError("输出不是有效的 MP4 容器。", 502);
        } finally { await handle.close(); }
        job.status = "succeeded";
        job.progress = 1;
      } catch (error) {
        job.status = this.closing ? "interrupted" : "failed";
        job.error = error instanceof VideoError ? error.message : this.closing ? "插件停止，生成已中断。" : "生成失败，请检查视频服务日志；任务未自动重试。";
        // A lost result does not prove that GPU work stopped. Terminate our own
        // provider before accepting another job, rather than stacking unknown work.
        this.online = false;
        await this.runtime.stop();
        for (const queued of this.jobs.values()) if (queued.status === "queued") {
          queued.status = "interrupted";
          queued.error = "生成服务停止，任务未自动重试。";
          await this.save(queued);
        }
      }
      await this.save(job);
      if (!this.online) return;
    }
  }
  async generate(job, workflow) {
    const clientId = randomUUID();
    const socket = new this.WebSocket(`${this.endpoint.replace("http:", "ws:")}/ws?clientId=${clientId}`);
    let settle, rejectResult, promptId;
    const result = new Promise((resolve, reject) => { settle = resolve; rejectResult = reject; });
    // The result can fail while the submission HTTP request is still pending.
    result.catch(() => {});
    const abort = () => rejectResult(new VideoError("插件停止，生成已中断。", 503));
    const timer = setTimeout(() => rejectResult(new VideoError("生成超过两小时，任务未自动重试。", 504)), 2 * 60 * 60 * 1000);
    this.controller.signal.addEventListener("abort", abort, { once: true });
    const inspect = async () => {
      if (!promptId) return;
      const record = (await this.request(`/history/${encodeURIComponent(promptId)}`))[promptId];
      if (record?.status?.status_str === "error") rejectResult(new VideoError("H3 执行失败，请检查视频服务日志。", 502));
      else if (record?.status?.completed) settle(record);
    };
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      try {
        const { type, data } = JSON.parse(event.data);
        if (!promptId || data?.prompt_id !== promptId) return;
        if (type === "progress" && data.max > 0) {
          job.progress = Math.min(0.99, data.value / data.max);
          this.publish("video.progress", { jobId: job.id, progress: job.progress });
        }
        if (type === "execution_error" || type === "execution_interrupted") rejectResult(new VideoError("H3 执行失败或中断。", 502));
        if (type === "execution_success" || (type === "executing" && data.node === null)) inspect().catch(rejectResult);
      } catch { rejectResult(new VideoError("H3 进度事件格式无效。", 502)); }
    });
    socket.addEventListener("error", () => rejectResult(new VideoError("H3 进度连接失败。", 502)));
    socket.addEventListener("close", () => rejectResult(new VideoError("H3 进度连接中断；任务未重复提交。", 502)));
    try {
      await Promise.race([new Promise(resolve => socket.addEventListener("open", resolve, { once: true })), result]);
      const submitted = await this.request("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) });
      if (!submitted.prompt_id || Object.keys(submitted.node_errors ?? {}).length) throw new VideoError("H3 拒绝了生成工作流。", 502);
      promptId = submitted.prompt_id;
      job.providerJobId = promptId;
      await this.save(job);
      await inspect();
      return await result;
    } finally { clearTimeout(timer); this.controller.signal.removeEventListener("abort", abort); socket.close(); }
  }
  async outputPath(job) {
    if (!job.output || /[\\/]/.test(job.output.filename) || !job.output.filename.startsWith(job.id)) throw new VideoError("视频输出引用无效。", 409);
    const root = await fs.realpath(path.join(this.runtime.stateRoot, "provider-output"));
    const target = path.resolve(root, job.output.subfolder, job.output.filename);
    const inside = candidate => { const relative = path.relative(root, candidate); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
    if (!inside(target) || !inside(await fs.realpath(target))) throw new VideoError("视频输出超出服务目录。", 409);
    return target;
  }
  async close() {
    this.closing = true;
    this.controller.abort();
    await this.active?.catch(() => {});
    await this.serial;
    await this.runtime.stop();
    this.unsubscribeExit?.();
    for (const job of this.jobs.values()) if (!this.runtime.readOnly && !this.catalog.states[job.status].terminal) { job.status = "interrupted"; job.error = "插件停止，任务未自动重试。"; await this.save(job); }
    this.online = false;
  }
}
