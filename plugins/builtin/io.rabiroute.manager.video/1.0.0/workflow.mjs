export function buildWorkflow(model, job, first, last) {
  const nodes = {
    "3": { class_type: "UNETLoader", inputs: { unet_name: model.files.diffusion, weight_dtype: "default" } },
    "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["3", 0], lora_name: model.files.lora, strength_model: 1 } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: model.files.textEncoder, type: "minimax", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: model.files.vae } },
    "8": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["5", 0], vae: ["6", 0], prompt: job.prompt, width: job.width, height: job.height, length: job.frames } },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: job.seed } },
    "10": { class_type: "BasicGuider", inputs: { model: ["4", 0], conditioning: ["8", 0] } },
    "11": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "12": { class_type: "BasicScheduler", inputs: { model: ["4", 0], scheduler: "simple", steps: 8, denoise: 1 } },
    "13": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["10", 0], sampler: ["11", 0], sigmas: ["12", 0], latent_image: ["8", 1] } },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["6", 0] } },
    "16": { class_type: "CreateVideo", inputs: { images: ["14", 0], fps: model.fps, bit_depth: 8 } },
    "17": { class_type: "SaveVideo", inputs: { video: ["16", 0], filename_prefix: `rabi-video/${job.id}`, format: "mp4", codec: "auto" } }
  };
  for (const [name, value, node] of [["first_frame", first, "1"], ["last_frame", last, "2"]]) {
    if (!value) continue;
    nodes[node] = { class_type: "LoadImage", inputs: { image: value } };
    nodes["8"].inputs[name] = [node, 0];
  }
  return nodes;
}

export function validateCommand(input, catalog) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求必须是 JSON 对象。");
  const allowed = new Set(["model", "prompt", "width", "height", "frames", "seed", "firstFrame", "lastFrame"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("请求包含不支持的参数。");
  const model = catalog.models.find(item => item.id === input.model);
  if (!model) throw new Error("请选择可用的视频模型。");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000) throw new Error("提示词须为 1–12000 个字符。");
  const result = { model: model.id, prompt: input.prompt.trim(), width: input.width ?? model.width, height: input.height ?? model.height, frames: input.frames ?? model.frames, seed: input.seed ?? 1 };
  if (![result.width, result.height].every(value => Number.isSafeInteger(value) && value >= 256 && value % 32 === 0) || result.width * result.height > model.maxArea) throw new Error("宽高须为不小于 256 的 32 倍数，且像素总数不超过模型上限。");
  if (!Number.isSafeInteger(result.frames) || result.frames < 22 || result.frames > model.maxFrames || (result.frames - 5) % 17 !== 0) throw new Error("帧数须为 17k+5，范围 22–260。");
  if (!Number.isSafeInteger(result.seed) || result.seed < 0) throw new Error("种子须为非负安全整数。");
  let dimensions;
  for (const name of ["firstFrame", "lastFrame"]) {
    if (input[name] === undefined || input[name] === "") continue;
    if (typeof input[name] !== "string" || input[name].length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input[name])) throw new Error("图片须为不超过 9 MB 的 PNG Base64。");
    const bytes = Buffer.from(input[name], "base64");
    if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("仅支持 PNG 图片。");
    const shape = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
    if (shape !== `${result.width}x${result.height}` || (dimensions && dimensions !== shape)) throw new Error("首尾帧必须与输出宽高完全一致，请先调整图片尺寸。");
    dimensions = shape;
    result[name] = input[name];
  }
  return result;
}
