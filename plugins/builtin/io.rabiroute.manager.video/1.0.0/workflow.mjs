import { selectWorkflow } from "./workflowRouting.mjs";
// Catalog owns the compatible sampling profiles. Omitted options preserve legacy jobs.
export function resolveWorkflow(model, command = {}, available) {
  const id = selectWorkflow(model, command, available);
  const profile = model.workflows?.[id];
  if (model.workflows && !profile) throw new Error("所选模型没有兼容的生成工作流。");
  const files = { ...model.files };
  if (profile?.loraKey) files.lora = files[profile.loraKey];
  delete files.lora4;
  if (profile && !profile.lora) delete files.lora;
  if (!command.generateAudio && model.mode !== "reference") delete files.audioVae;
  return { ...model, files, steps: profile?.steps ?? model.steps, workflowId: id ?? model.id };
}

export function buildWorkflow(model, job, first, last, references = []) {
  model = resolveWorkflow(model, job);
  if (model.mode === "image") return {
    "1": {class_type:"UNETLoader",inputs:{unet_name:model.files.diffusion,weight_dtype:"default"}},
    "2": {class_type:"CLIPLoader",inputs:{clip_name:model.files.textEncoder,type:"lumina2",device:"default"}},
    "3": {class_type:"VAELoader",inputs:{vae_name:model.files.vae}},
    "4": {class_type:"CLIPTextEncode",inputs:{clip:["2",0],text:job.prompt}},
    "5": {class_type:"ConditioningZeroOut",inputs:{conditioning:["4",0]}},
    "6": {class_type:"EmptySD3LatentImage",inputs:{width:job.width,height:job.height,batch_size:1}},
    "7": {class_type:"ModelSamplingAuraFlow",inputs:{model:["1",0],shift:3}},
    "8": {class_type:"KSampler",inputs:{model:["7",0],positive:["4",0],negative:["5",0],latent_image:["6",0],seed:job.seed,steps:8,cfg:1,sampler_name:"res_multistep",scheduler:"simple",denoise:1}},
    "9": {class_type:"VAEDecode",inputs:{samples:["8",0],vae:["3",0]}},
    "10": {class_type:"SaveImage",inputs:{images:["9",0],filename_prefix:`rabi-image/${job.id}`}}
  };
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
  if (!model.files.lora) {
    delete nodes["4"];
    nodes["10"].inputs.model = ["3",0]; nodes["12"].inputs.model = ["3",0];
  }
  nodes["12"].inputs.steps = model.steps || 8;
  if (model.mode === "reference") {
    nodes["7"] = {class_type:"VAELoader",inputs:{vae_name:model.files.audioVae}};
    nodes["8"] = {class_type:"MiniMaxH3ReferenceToVideo",inputs:{clip:["5",0],vae:["6",0],audio_vae:["7",0],prompt:job.prompt,width:job.width,height:job.height,length:job.frames,ref_image_size:"match"}};
    const counts = {image:0,video:0,audio:0};
    references.forEach((asset,index)=> {
      const id=String(100+index*2), n=counts[asset.kind]++;
      if(asset.kind==="image") {
        nodes[id]={class_type:"LoadImage",inputs:{image:asset.filename}};
        nodes["8"].inputs[`ref_images.ref_image_${n}`]=[id,0];
      } else if(asset.kind==="video") {
        nodes[id]={class_type:"LoadVideo",inputs:{file:asset.filename}};
        const parts=String(101+index*2);
        nodes[parts]={class_type:"GetVideoComponents",inputs:{video:[id,0]}};
        nodes["8"].inputs[`ref_videos.ref_video_${n}`]=[parts,0];
        if(job.referenceVideoSound && asset.hasAudio) nodes["8"].inputs[`ref_video_audios.ref_video_audio_${n}`]=[parts,1];
      } else {
        nodes[id]={class_type:"LoadAudio",inputs:{audio:asset.filename}};
        nodes["8"].inputs[`ref_audios.ref_audio_${n}`]=[id,0];
      }
    });

  }
  if (job.generateAudio) {
    if (!model.files.audioVae) throw new Error("所选工作流缺少音频 VAE。");
    nodes["7"] = {class_type:"VAELoader",inputs:{vae_name:model.files.audioVae}};
    nodes["15"] = {class_type:"VAEDecodeAudio",inputs:{samples:["13",0],vae:["7",0]}};
    nodes["16"].inputs.audio = ["15",0];
  }
  for (const [name, value, node] of [["first_frame", first, "1"], ["last_frame", last, "2"]]) {
    if (!value) continue;
    nodes[node] = { class_type: "LoadImage", inputs: { image: value } };
    nodes["8"].inputs[name] = [node, 0];
  }
  return nodes;
}

export function validateCommand(input, catalog) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求必须是 JSON 对象。");
  const allowed = new Set(["model", "prompt", "width", "height", "frames", "seed", "firstFrame", "lastFrame", "references", "generateAudio", "referenceVideoSound", "quickGeneration"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("请求包含不支持的参数。");
  const model = catalog.models.find(item => item.id === input.model);
  if (!model) throw new Error("请选择可用的视频模型。");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000) throw new Error("提示词须为 1–12000 个字符。");
  const result = { model: model.id, prompt: input.prompt.trim(), width: input.width ?? model.width, height: input.height ?? model.height, frames: input.frames ?? model.frames, seed: input.seed ?? 1 };
  if (input.quickGeneration !== undefined) {
    if (typeof input.quickGeneration !== "boolean" || !model.workflows) throw new Error("快速生成选项不适用于该模型。");
    result.quickGeneration = input.quickGeneration;
  }
  if (model.mode === "image") {
    if (["frames","firstFrame","lastFrame","references","generateAudio","referenceVideoSound"].some(key => input[key] !== undefined)) throw new Error("图片模型仅支持文生图参数。");
    if (![result.width,result.height].every(n=>Number.isSafeInteger(n)&&n>=256&&n<=2048&&n%32===0)||result.width*result.height>model.maxArea) throw new Error("图片宽高须为 256–2048 的 32 倍数。");
    if (!Number.isSafeInteger(result.seed)||result.seed<0) throw new Error("种子须为非负安全整数。");
    delete result.frames; return result;
  }
  if (input.generateAudio !== undefined) {
    if (typeof input.generateAudio !== "boolean") throw new Error("声音选项须为布尔值。");
    result.generateAudio = input.generateAudio;
  }
  if(input.references !== undefined || input.referenceVideoSound !== undefined || model.mode === "reference") {
    if(model.mode!=="reference" || input.firstFrame || input.lastFrame) throw new Error("参考素材与首尾帧须使用各自的生成模式。");
    if(!Array.isArray(input.references) || input.references.length<1 || input.references.length>15 || input.references.some(id=>typeof id!=="string" || !/^[a-f0-9-]{36}$/.test(id)) || new Set(input.references).size!==input.references.length) throw new Error("参考素材列表无效。");
    for(const key of ["generateAudio","referenceVideoSound"]) if(input[key]!==undefined && typeof input[key]!=="boolean") throw new Error("声音选项须为布尔值。");
    result.references=[...input.references]; result.generateAudio=!!input.generateAudio; result.referenceVideoSound=!!input.referenceVideoSound;
  }
  if(model.mode==="reference" && !result.references) throw new Error("请添加参考素材。");
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
