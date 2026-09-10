<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TtsModelParameters from "../components/TtsModelParameters.vue";
import {normalizeTtsParameters,ttsCommandSettings,type TtsParameters} from "../speech/ttsParameters";
import AudioPromptEditor from "../components/AudioPromptEditor.vue";
import { synthesizeWithPauses } from "../speech/audioPause";
import { speechControlClient } from "../speech/speechControlClient";
import type { SpeechModel } from "@shared/speechControlContract";
import { readDraft, writeDraft } from "./videoDraftStorage";
import { useVideoCanvas } from "./useVideoCanvas";
import { managerEventSource, managerResourceUrl } from "../managerApi";

type WorkflowProfile = { kind?: string; label: string; steps: number };
type Model = { workflows?: Record<string, WorkflowProfile>; defaultWorkflow?: string; id: string; label: string; mode?: string; fps: number; width: number; height: number; frames: number };
type AssetKind = "image" | "video" | "audio";
type Asset = { id: string; kind: AssetKind; width?: number; height?: number; duration?: number; hasAudio?: boolean };
type Job = { quickGeneration?: boolean; workflowId?: string; samplingSteps?: number; id: string; prompt: string; model?: string; width?: number; height?: number; frames?: number; seed?: number; references?: string[]; generateAudio?: boolean; referenceVideoSound?: boolean; hasFirstFrame?: boolean; hasLastFrame?: boolean; status: string; progress: number; createdAt: string; error?: string; videoUrl?: string; imageUrl?: string; mediaKind?: string };
type Snapshot = { availableWorkflows?: { model: string; workflowId: string; generateAudio: boolean }[]; online: boolean; availableModels?: string[]; models: Model[]; states: Record<string, { label: string; terminal: boolean }>; jobs: Job[] };
const snapshot = ref<Snapshot>();
type ModelManagement = { runtimeInstalled: boolean; models: { id: string; label: string; bytes: number; installed: boolean }[]; job: { kind: string; state: string; bytes: number; total: number; message?: string } | null };
type Directories = { revision: number; modelRoot: string | null; effectiveModelRoot: string; defaultModelRoot: string };
const management = ref<ModelManagement>();
const directories = ref<Directories>();
const modelDirectory = ref("");
const showModels = ref(false);
const showLibrary = ref(false);
const installing = computed(() => management.value?.job?.state === "running");
async function refreshModels() { management.value = await request<ModelManagement>("/models"); }
async function openModels() {
  showModels.value = true;
  await refreshModels();
  directories.value = await request<Directories>("/models/settings");
  modelDirectory.value = directories.value.modelRoot || "";
}
async function saveDirectory() {
  directories.value = await request<Directories>("/models/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelRoot: modelDirectory.value.trim() || null, expectedRevision: directories.value?.revision }) });
  await refreshModels();
}
async function install(route: string) { await request(route, { method: "POST" }); await refreshModels(); }
const error = ref("");
const busy = ref(false);
const prompt = ref("");
const model = ref("");
const width = ref(768), height = ref(768), frames = ref(107), seed = ref(1);
const firstFrame = ref(""), lastFrame = ref("");
const firstName = ref(""), lastName = ref("");
const mode = ref("text"), filter = ref("all"), search = ref(""), selectedId = ref("");
const notice = ref("");
const noticeVisible = computed({ get: () => !!notice.value, set: value => { if (!value) notice.value = ""; } });
const references = ref<Asset[]>([]), uploading = ref(false);
const quickGeneration = ref(false);
const generateAudio = ref(false), referenceVideoSound = ref(false);
const referenceKinds: { id: AssetKind; label: string; icon: string; accept: string; limit: number; bytes: number }[] = [
  { id: "image", label: "图片", icon: "mdi-image-outline", accept: "image/png", limit: 9, bytes: 9 * 1024 ** 2 },
  { id: "video", label: "视频", icon: "mdi-video-outline", accept: "video/mp4", limit: 3, bytes: 64 * 1024 ** 2 },
  { id: "audio", label: "音频", icon: "mdi-music-note-outline", accept: ".wav", limit: 3, bytes: 16 * 1024 ** 2 },
];
const availableModels = computed(() => (snapshot.value?.models || []).filter(item => item.mode !== "image").filter(item => (item.mode === "reference") === (mode.value === "reference")));
const selectedWorkflow = computed(() => snapshot.value?.models.find(item => item.id === model.value)?.workflows?.[quickGeneration.value ? "fast" : "standard"]);
const workflowProblem = computed(() => {
  if (!snapshot.value?.models.find(item => item.id === model.value)?.workflows) return "请更新视频服务以使用标准／快速工作流。";
  if (snapshot.value.online && !snapshot.value.availableWorkflows?.some(item => item.model === model.value && (snapshot.value?.models.find(row => row.id === model.value)?.workflows?.[item.workflowId]?.kind || item.workflowId) === (quickGeneration.value ? "fast" : "standard") && item.generateAudio === generateAudio.value)) return "当前工作流或声音依赖未就绪，请检查模型管理。";
  return "";
});
function setMode(value: string) {
  mode.value = value;
  if (!availableModels.value.some(item => item.id === model.value)) model.value = availableModels.value[0]?.id || "";
}
function cryptoSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]!; }
function swapFrames() {
  [firstFrame.value, lastFrame.value] = [lastFrame.value, firstFrame.value];
  [firstName.value, lastName.value] = [lastName.value, firstName.value];
  [frameShapes.value.first, frameShapes.value.last] = [frameShapes.value.last!, frameShapes.value.first!];
}
function referenceLabel(asset: Asset) {
  const position = references.value.filter(item => item.kind === asset.kind).findIndex(item => item.id === asset.id) + 1;
  const audioOffset = asset.kind === "audio" && referenceVideoSound.value ? references.value.filter(item => item.kind === "video" && item.hasAudio).length : 0;
  return `<${{ image: "Picture", video: "Video", audio: "Audio" }[asset.kind]} ${position + audioOffset}>`;
}
function changeReferences(change: () => void) {
  const before = referenceTags();
  change();
  const after = new Map([...referenceTags()].map(([tag,id]) => [id,tag]));
  prompt.value = prompt.value.replace(/<(?:Picture|Video|Audio) \d+>/g, tag => before.has(tag) ? after.get(before.get(tag)!) || "" : tag);
}
function videoSoundLabel(asset: Asset) {
  return `<Audio ${references.value.filter(item => item.kind === "video" && item.hasAudio).findIndex(item => item.id === asset.id) + 1}>`;
}
function referenceTags() {
  const result = new Map(references.value.map(asset => [referenceLabel(asset),asset.id]));
  if (referenceVideoSound.value) for (const asset of references.value.filter(item => item.kind === "video" && item.hasAudio)) result.set(videoSoundLabel(asset),`${asset.id}:sound`);
  return result;
}
function removeReference(index: number) { changeReferences(() => references.value.splice(index, 1)); }
function setVideoSound(value: boolean | null) { changeReferences(() => { referenceVideoSound.value = !!value; }); }
async function uploadReferences(event: Event, kind: AssetKind) {
  const input = event.target as HTMLInputElement, files = Array.from(input.files || []); input.value = "";
  if (!files.length || uploading.value) return;
  const rule = referenceKinds.find(item => item.id === kind)!;
  if (references.value.filter(item => item.kind === kind).length + files.length > rule.limit) { error.value = `${rule.label}最多 ${rule.limit} 个。`; return; }
  if (files.some(file => file.size > rule.bytes)) { error.value = `${rule.label}每个文件最大 ${rule.bytes / 1024 ** 2} MB。`; return; }
  uploading.value = true; error.value = "";
  try {
    for (const file of files) {
      const asset = await request<Asset>(`/assets?kind=${kind}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
      changeReferences(() => references.value.push(asset));
    }
  } catch (failure) { error.value = failure instanceof Error ? failure.message : "素材上传失败。"; }
  finally { uploading.value = false; }
}
const frameShapes = ref<Record<string, string>>({});
const ratios = [
  { label: "16:9", width: 1024, height: 576 },
  { label: "4:3", width: 896, height: 672 },
  { label: "1:1", width: 768, height: 768 },
  { label: "3:4", width: 672, height: 896 },
  { label: "9:16", width: 576, height: 1024 },
  { label: "21:9", width: 1120, height: 480 },
];
const resolutions = [{ label: "480P", edge: 480 }, { label: "720P", edge: 720 }];
function resolutionSize(ratio: number, edge: number) {
  return { width: Math.round(edge * Math.max(1, ratio) / 32) * 32, height: Math.round(edge * Math.max(1, 1 / ratio) / 32) * 32 };
}
const selectedRatio = computed(() => ratios.find(item => Math.abs((width.value / height.value) / (item.width / item.height) - 1) < 0.025));
const selectedResolution = computed(() => resolutions.find(item => {
  const ratio = selectedRatio.value;
  if (!ratio) return false;
  const size = resolutionSize(ratio.width / ratio.height, item.edge);
  return size.width === width.value && size.height === height.value;
}));
function resolutionAllowed(edge: number) {
  const ratio = selectedRatio.value;
  const size = resolutionSize(ratio ? ratio.width / ratio.height : width.value / height.value, edge);
  return size.width * size.height <= 1032192;
}
function applyResolution(edge: number) {
  if (!resolutionAllowed(edge)) return;
  const ratio = selectedRatio.value;
  const size = resolutionSize(ratio ? ratio.width / ratio.height : width.value / height.value, edge);
  width.value = size.width; height.value = size.height;
}
function applyRatio(ratio: typeof ratios[number]) {
  const resolution = selectedResolution.value;
  const size = resolution ? resolutionSize(ratio.width / ratio.height, resolution.edge) : ratio;
  if (size.width * size.height > 1032192) {
    notice.value = "此画幅在当前分辨率下超出像素上限，请先选择较低分辨率。";
    return;
  }
  width.value = size.width; height.value = size.height;
}
const filteredJobs = computed(() => (snapshot.value?.jobs || []).filter(job => (filter.value === "all" || (filter.value === "pending" ? !snapshot.value?.states[job.status]?.terminal : job.status === filter.value)) && job.prompt.toLowerCase().includes((search.value || "").trim().toLowerCase())));
const canvas = useVideoCanvas();
const minimapOpen = ref(true);
const minimap = canvas.minimap;
const selectedIds = canvas.selectedIds;
const marquee = canvas.marquee;
function navigateMinimap(event: MouseEvent) {
  const bounds = (event.currentTarget as SVGElement).getBoundingClientRect();
  canvas.locateMinimap((event.clientX - bounds.left) / bounds.width * 180, (event.clientY - bounds.top) / bounds.height * 110);
}
const { viewport, scale, handMode, dragging, transform: canvasTransform, grid: canvasGrid } = canvas;
type CanvasKind = "video" | "image" | "audio" | "text";
type CanvasItem = { id: string; kind: CanvasKind; title: string; jobId?: string; asset?: Asset; text: string; imageModel?: string; imageSize?: string; imageTier?: string; imageKey?: string; imageBody?: string; audioMode?: "generate" | "reference"; audioModel?: string; audioParameters?: TtsParameters; audioSettingsOpen?: boolean; audioVoiceMode?: "default" | "custom"; audioVoice?: string; audioSpeed?: number; audioUrl?: string; audioError?: string; audioBusy?: boolean };
const canvasItems = ref<CanvasItem[]>([{ id: "draft-1", kind: "video", title: "视频 1", text: "" }]);
const activeVideoId = ref("draft-1");
const selectedCanvasId = ref("draft-1");
canvas.add("draft-1");
const activeVideo = computed(() => canvasItems.value.find(item => item.id === activeVideoId.value)!);
const otherItems = computed(() => canvasItems.value.filter(item => item.id !== activeVideoId.value));
const selected = computed(() => snapshot.value?.jobs.find(job => job.id === activeVideo.value.jobId));
const openPopover = ref("");
function updatePopover(key: string, opened: boolean) {
  if (opened) openPopover.value = key;
  else if (openPopover.value === key) openPopover.value = "";
}
function dismissCanvasPopovers(event: PointerEvent) {
  if ((event.target as Element).closest(".canvas-object,.canvas-tools,.workspace-tools,.canvas-minimap,.canvas-menu,.output-library,.v-overlay")) return;
  openPopover.value = "";
  contextMenu.value = undefined;
}
const contextMenu = ref<{ x: number; y: number; world?: { x: number; y: number }; itemId?: string }>();
const canvasKinds: { kind: CanvasKind; label: string; icon: string }[] = [
  { kind: "text", label: "文本", icon: "mdi-format-text" },
  { kind: "image", label: "图片", icon: "mdi-image-outline" },
  { kind: "video", label: "视频", icon: "mdi-video-outline" },
  { kind: "audio", label: "音频", icon: "mdi-music-note-outline" },
];
function captureDraft() {
  return { prompt: prompt.value, model: model.value, mode: mode.value, width: width.value, height: height.value, frames: frames.value, seed: seed.value, firstFrame: firstFrame.value, lastFrame: lastFrame.value, firstName: firstName.value, lastName: lastName.value, shapes: { ...frameShapes.value }, references: [...references.value], quickGeneration: quickGeneration.value, generateAudio: generateAudio.value, referenceVideoSound: referenceVideoSound.value };
}
const drafts = new Map<string, ReturnType<typeof captureDraft>>();
function selectCanvasVideo(item: CanvasItem) {
  if (item.kind !== "video" || busy.value || uploading.value || activeVideoId.value === item.id) return;
  drafts.set(activeVideoId.value, captureDraft());
  activeVideoId.value = item.id;
  const draft = drafts.get(item.id);
  prompt.value = draft?.prompt || ""; mode.value = draft?.mode || "text";
  model.value = draft?.model || availableModels.value[0]?.id || "";
  width.value = draft?.width ?? 768; height.value = draft?.height ?? 768;
  frames.value = draft?.frames ?? 107; seed.value = draft?.seed ?? cryptoSeed();
  firstFrame.value = draft?.firstFrame || ""; lastFrame.value = draft?.lastFrame || "";
  firstName.value = draft?.firstName || ""; lastName.value = draft?.lastName || "";
  frameShapes.value = { ...draft?.shapes }; references.value = [...(draft?.references || [])];
  quickGeneration.value = draft?.quickGeneration ?? false;
  generateAudio.value = !!draft?.generateAudio; referenceVideoSound.value = !!draft?.referenceVideoSound;
  error.value = "";
}
function selectCard(item: CanvasItem) {
  if (item.kind === "audio" && !audioModels.value.length) void loadAudioModels();
  openPopover.value = "";
  selectedCanvasId.value = item.id;
  selectedIds.value = [item.id];
  selectCanvasVideo(item);
}
function cardPointerDown(event: PointerEvent, item: CanvasItem) {
  if (event.button !== 0 && event.button !== 1) return;
  const target = event.target as HTMLElement;
  if (target.closest(".composer,.result-details")) return;
  if (event.button === 1 || handMode.value) { event.stopPropagation(); canvas.begin(event); return; }
  if (!selectedIds.value.includes(item.id)) selectCard(item);
  if (target.closest("input,textarea,video,audio,label,a,button:not(.canvas-drag-handle)")) return;
  event.stopPropagation();
  openPopover.value = "";
  contextMenu.value = undefined;
  canvas.begin(event, item.id);
}
function openCanvasMenu(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("input,textarea,video,audio,.v-overlay")) return;
  event.preventDefault();
  openPopover.value = "";
  const element = viewport.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  contextMenu.value = { x: Math.max(8, Math.min(point.x, element.clientWidth - 210)), y: Math.max(8, Math.min(point.y, element.clientHeight - 330)), world: (event.target as HTMLElement).closest(".workspace-tools") ? undefined : canvas.world(point) };
}
function openCardMenu(event: MouseEvent, item: CanvasItem) {
  if ((event.target as HTMLElement).closest("input,textarea,.composer")) return;
  event.stopPropagation(); openCanvasMenu(event);
  if (contextMenu.value) contextMenu.value.itemId = item.id;
}
function duplicateCard(empty: boolean) {
  if (busy.value || uploading.value) return;
  const source = canvasItems.value.find(row => row.id === contextMenu.value?.itemId);
  if (!source) return;
  const item: CanvasItem = { ...source, id: crypto.randomUUID(), title: `${source.title} 副本`, ...(empty ? { text: "", asset: undefined, jobId: undefined, audioUrl: undefined, audioError: undefined, audioBusy: false } : {}) };
  const draft = source.id === activeVideoId.value ? captureDraft() : drafts.get(source.id);
  if (!empty && draft) drafts.set(item.id, JSON.parse(JSON.stringify(draft)));
  canvasItems.value.push(item); canvas.add(item.id);
  const origin = canvas.positions.value[source.id]!;
  canvas.positions.value[item.id] = { x: origin.x + 60, y: origin.y + 60 };
  contextMenu.value = undefined; selectCard(item);
}
function deleteCard() {
  if (busy.value || uploading.value) return;
  const id = contextMenu.value?.itemId;
  if (!id) return;
  if (id === activeVideoId.value) {
    let next = canvasItems.value.find(row => row.kind === "video" && row.id !== id);
    if (!next) {
      next = { id: crypto.randomUUID(), kind: "video", title: "视频 1", text: "" };
      canvasItems.value.push(next); canvas.add(next.id);
    }
    selectCard(next);
  }
  canvasItems.value = canvasItems.value.filter(row => row.id !== id);
  delete canvas.positions.value[id]; drafts.delete(id);
  selectedIds.value = selectedIds.value.filter(key => key !== id);
  contextMenu.value = undefined;
  notice.value = "已移除画布节点，作品历史和素材文件保留。";
}
function exportCard() {
  const item = canvasItems.value.find(row => row.id === contextMenu.value?.itemId);
  if (!item) return;
  const draft = item.id === activeVideoId.value ? captureDraft() : drafts.get(item.id);
  const data = { format: "rabi-video-node", version: 1, title: item.title, kind: item.kind, text: item.text, parameters: draft ? { prompt: draft.prompt, model: draft.model, mode: draft.mode, width: draft.width, height: draft.height, frames: draft.frames, seed: draft.seed, quickGeneration: draft.quickGeneration, generateAudio: draft.generateAudio, referenceVideoSound: draft.referenceVideoSound } : undefined };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "rabi-video-node.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  contextMenu.value = undefined; notice.value = "已导出节点参数，不包含参考素材和生成文件。";
}
function addCanvasItem(kind: CanvasKind) {
  if (busy.value || uploading.value) return;
  const count = canvasItems.value.filter(item => item.kind === kind).length + 1;
  const item: CanvasItem = { id: crypto.randomUUID(), kind, title: `${canvasKinds.find(entry => entry.kind === kind)!.label} ${count}`, text: "" };
  canvasItems.value.push(item); canvas.add(item.id);
  if (contextMenu.value?.world) canvas.positions.value[item.id] = contextMenu.value.world;
  contextMenu.value = undefined;
  selectCard(item);
  canvas.center(item.id);
}
function addJobToCanvas(job: Job) {
  if (busy.value || uploading.value) return;
  let item = canvasItems.value.find(row => row.jobId === job.id);
  if (!item) {
    item = { id: crypto.randomUUID(), kind: job.mediaKind === "image" ? "image" : "video", title: job.mediaKind === "image" ? "生成图片" : `视频 ${canvasItems.value.filter(row=>row.kind==='video').length + 1}`, text: job.prompt, jobId: job.id };
    canvasItems.value.push(item); canvas.add(item.id);
  }
  selectCard(item); showLibrary.value = false; canvas.center(item.id);
}
const imageModels = computed(() => (snapshot.value?.models || []).filter(row => row.mode === "image"));
const imageRatios = [{label:"1:1",w:1024,h:1024},{label:"4:3",w:1152,h:864},{label:"3:4",w:864,h:1152},{label:"16:9",w:1344,h:768},{label:"9:16",w:768,h:1344},{label:"3:2",w:1248,h:832},{label:"2:3",w:832,h:1248}];
function imageRatio(item: CanvasItem) {
  const [w,h]=(item.imageSize || "1024x1024").split("x").map(Number);
  return imageRatios.reduce((best,row)=>Math.abs(row.w/row.h-w!/h!)<Math.abs(best.w/best.h-w!/h!) ? row : best,imageRatios[0]!);
}
function imageQuality(item: CanvasItem) { if (item.imageTier) return item.imageTier; return Math.max(...(item.imageSize || "1024x1024").split("x").map(Number))>=2048 ? "2K" : "1K"; }
function setImageFormat(item: CanvasItem, ratio=imageRatio(item), quality=imageQuality(item)) {
  const factor=quality==="480P" ? 480/Math.min(ratio.w,ratio.h) : quality==="720P" ? 720/Math.min(ratio.w,ratio.h) : quality==="2K" ? 2048/Math.max(ratio.w,ratio.h) : 1;
  item.imageTier=quality;
  item.imageSize=`${Math.round(ratio.w*factor/32)*32}x${Math.round(ratio.h*factor/32)*32}`;
}

function imageJob(item: CanvasItem) { return snapshot.value?.jobs.find(row=>row.id===item.jobId); }
function imageSource(item: CanvasItem) { const url=imageJob(item)?.imageUrl; return url ? managerResourceUrl(url) : item.asset ? managerResourceUrl(`/api/video/assets/${item.asset.id}`) : undefined; }
async function generateImage(item: CanvasItem) {
  const [w,h]=(item.imageSize || "1024x1024").split("x").map(Number);
  const body=JSON.stringify({model:item.imageModel || imageModels.value[0]?.id,prompt:item.text,width:w,height:h,seed:1});
  if(item.imageBody!==body) {item.imageKey=crypto.randomUUID();item.imageBody=body;}
  const job=await request<Job>("/jobs",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":item.imageKey!},body});
  item.jobId=job.id; item.imageKey=undefined; item.imageBody=undefined; await refresh();
}
async function useGeneratedImage(item: CanvasItem) {
  const url=imageSource(item); if(!url)return;
  if(imageJob(item)?.imageUrl) {
    const response=await fetch(url); if(!response.ok)throw new Error("读取生成图片失败。");
    const blob=await response.blob(); if(blob.size>9*1024**2)throw new Error("图片超过参考素材 9 MB 上限。");
    item.asset=await request<Asset>("/assets?kind=image",{method:"POST",headers:{"content-type":"application/octet-stream"},body:blob});
  }
  useCanvasReference(item); selectCard(activeVideo.value);
}
const audioModels = ref<SpeechModel[]>([]);
const audioCatalogError = ref("");
const audioEditors = new Map<string, InstanceType<typeof AudioPromptEditor>>();
const audioInsertGroups = [
  {id:"pause",label:"停顿",items:[{label:"短停顿 0.5s",detail:"<#0.5#>",text:"<#0.5#>"},{label:"中停顿 1s",detail:"<#1#>",text:"<#1#>"},{label:"长停顿 2s",detail:"<#2#>",text:"<#2#>"}]},
  {id:"interjection",label:"语气词",items:[{label:"嗯",detail:"思考 / 应答",text:"<[嗯]>"},{label:"啊",detail:"感叹",text:"<[啊]>"},{label:"哦",detail:"回应",text:"<[哦]>"},{label:"唉",detail:"叹息",text:"<[唉]>"}]}
];
function insertAudioText(item: CanvasItem, text: string) {
  audioEditors.get(item.id)?.insert(text);
  openPopover.value="";
}
const generatedAudio = new Map<string, Blob>();
async function loadAudioModels() {
  try { audioModels.value = (await speechControlClient.models()).models.filter(row => row.capability === "tts"); audioCatalogError.value = ""; }
  catch { audioCatalogError.value = "未连接语音服务，请在正式 Rabi 页面启用 TTS 后刷新。"; }
}
function selectedAudioModel(item:CanvasItem){return audioModels.value.find(row=>row.id===item.audioModel) || (!item.audioModel ? audioModels.value.find(row=>row.available) : undefined);}
function selectAudioModel(item:CanvasItem,model:SpeechModel){item.audioModel=model.id;item.audioParameters=normalizeTtsParameters(model);item.audioVoice=undefined;item.audioSpeed=undefined;item.audioError="";}
function audioParameterValues(item:CanvasItem){return normalizeTtsParameters(selectedAudioModel(item),item.audioParameters || {voice:item.audioVoice,speed:item.audioSpeed});}
function audioSource(item: CanvasItem) { return item.audioUrl || (item.asset ? managerResourceUrl(`/api/video/assets/${item.asset.id}`) : undefined); }
async function generateAudioCard(item: CanvasItem) {
  if (item.audioBusy || !item.text.trim()) return;
  item.audioBusy = true; item.audioError = "";
  try {
    const chosen=selectedAudioModel(item);if(!chosen?.available)throw new Error("所选 TTS 模型尚未就绪。");
    const settings=ttsCommandSettings(chosen,audioParameterValues(item));
    const audio = await synthesizeWithPauses(item.text, async input=>{
      const result=await speechControlClient.synthesize({...settings,input});
      if(!result.audio?.size)throw new Error("语音服务没有返回音频。");
      return result.audio;
    });
    const url=URL.createObjectURL(audio);generatedAudio.set(url,audio);
    item.audioUrl = url; item.asset = undefined;
  } catch (cause) { item.audioError = cause instanceof Error ? cause.message : String(cause); }
  finally { item.audioBusy = false; }
}
async function useAudioReference(item: CanvasItem) {
  if (item.audioUrl) {
    const blob = generatedAudio.get(item.audioUrl); if (!blob) throw new Error("音频已失效，请重新生成。");
    if (blob.size > 16*1024**2) throw new Error("参考音频最大 16 MB。");
    item.asset = await request<Asset>("/assets?kind=audio",{method:"POST",headers:{"content-type":"application/octet-stream"},body:blob});
  }
  useCanvasReference(item); selectCard(activeVideo.value);
}
function canvasVideoUrl(item: CanvasItem) {
  const videoUrl = snapshot.value?.jobs.find(job => job.id === item.jobId)?.videoUrl;
  return videoUrl ? managerResourceUrl(videoUrl) : item.asset ? managerResourceUrl(`/api/video/assets/${item.asset.id}`) : undefined;
}
async function uploadCanvasAsset(event: Event, item: CanvasItem) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = "";
  if (!file || item.kind === "text" || uploading.value || busy.value) return;
  const kind = item.kind as AssetKind, rule = referenceKinds.find(row=>row.id===kind)!;
  if (file.size > rule.bytes) { error.value = `${rule.label}文件最大 ${rule.bytes / 1024 ** 2} MB。`; return; }
  uploading.value = true;
  try {
    item.asset = await request<Asset>(`/assets?kind=${kind}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
    item.jobId = undefined;
    if (item.kind === "audio") item.audioUrl = undefined;
    if (item.kind === "video") {
      setMode("reference");
      const asset = item.asset;
      if (references.value.filter(row=>row.kind==='video').length < 3) changeReferences(()=>references.value.push(asset));
      else notice.value = "视频已上传，参考列表已满，请先移除一个视频参考。";
    }
  }
  catch (failure) { error.value = failure instanceof Error ? failure.message : "素材上传失败。"; }
  finally { uploading.value = false; }
}
function useCanvasReference(item: CanvasItem) {
  if (!item.asset || busy.value || uploading.value) return;
  const asset = item.asset, rule = referenceKinds.find(row=>row.id===asset.kind)!;
  if (references.value.some(row=>row.id===asset.id)) { notice.value = "素材已在当前参考列表中。"; return; }
  if (references.value.filter(row=>row.kind===asset.kind).length >= rule.limit) { error.value = `${rule.label}参考已达到上限。`; return; }
  setMode("reference"); changeReferences(()=>references.value.push(asset)); canvas.center(activeVideoId.value);
}
function resetCanvasView() { canvas.zoom(1); canvas.center(activeVideoId.value); }

const inputProblem = computed(() => {
  if (!model.value) return "当前模式没有可用的生成方案。";
  if (workflowProblem.value) return workflowProblem.value;
  if (mode.value === "reference" && !references.value.length) return "请添加图片、视频或音频参考。";
  if (snapshot.value?.online && !snapshot.value.availableModels?.includes(model.value)) return "当前方案尚未就绪，请在模型管理中检查下载，并重启视频服务。";
  if (mode.value === "image" && !firstFrame.value && !lastFrame.value) return "请添加首帧或尾帧。";
  if (mode.value === "image" && Object.values(frameShapes.value).some(shape => shape !== `${width.value}×${height.value}`)) return "图片尺寸须与所选画幅和清晰度一致，请调整图片或切换预设。";
  if (![width.value, height.value].every(value => Number.isSafeInteger(value) && value >= 256 && value % 32 === 0) || width.value * height.value > 1032192) return "宽高须为 32 的倍数，总像素不超过 1032192。";
  if (!Number.isSafeInteger(frames.value) || frames.value < 22 || frames.value > 260 || (frames.value - 5) % 17 !== 0) return "帧数须为 17k+5，范围 22–260。";
  if (!Number.isSafeInteger(seed.value) || seed.value < 0) return "随机种子须为非负整数。";
  return "";
});
function clearImage(first: boolean) {
  if (first) { firstFrame.value = ""; firstName.value = ""; delete frameShapes.value.first; }
  else { lastFrame.value = ""; lastName.value = ""; delete frameShapes.value.last; }
}
async function reuse(job: Job) {
  if (uploading.value || busy.value) return;
  prompt.value = job.prompt;
  if (job.model) model.value = job.model;
  width.value = job.width ?? width.value; height.value = job.height ?? height.value;
  frames.value = job.frames ?? frames.value; seed.value = job.seed ?? seed.value;
  clearImage(true); clearImage(false);
  mode.value = job.references?.length ? "reference" : job.hasFirstFrame || job.hasLastFrame ? "image" : "text";
  quickGeneration.value = job.quickGeneration ?? ((job.workflowId || snapshot.value?.models.find(item => item.id === job.model)?.defaultWorkflow) === "fast");
  references.value = []; generateAudio.value = !!job.generateAudio; referenceVideoSound.value = !!job.referenceVideoSound;
  if (job.references?.length) {
    await action(async () => { references.value = await Promise.all(job.references!.map(id => request<Asset>(`/assets/${id}?metadata=1`))); });
    if (error.value) return;
  }
  notice.value = mode.value === "image" ? "参数已填入，请重新添加参考图片。" : "参数已填入，可修改后再次生成。";
}
async function copyPrompt(job: Job) {
  try { await navigator.clipboard.writeText(job.prompt); notice.value = "提示词已复制。"; }
  catch { error.value = "复制失败，请手动选择提示词复制。"; }
}
function cancelSelected() {
  const job = selected.value;
  if (job?.status === "queued") void action(() => request(`/jobs/${job.id}/cancel`, { method: "POST" }));
}
let events: EventSource | undefined;
let refreshFlight: Promise<void> | undefined;
let pendingSubmission: { body: string; key: string } | undefined;
let disposed = false;
const duration = computed(() => (frames.value / (snapshot.value?.models.find(item => item.id === model.value)?.fps || 24)).toFixed(2));
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/video${route}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body as T;
}
function refresh(): Promise<void> {
  if (refreshFlight) return refreshFlight;
  refreshFlight = request<Snapshot>("/status").then(value => {
    if (disposed) return;
    snapshot.value = value;
    if (!model.value) model.value = value.models[0]?.id || "";
  }).finally(() => { refreshFlight = undefined; });
  return refreshFlight;
}
async function action(operation: () => Promise<unknown>) {
  busy.value = true; error.value = "";
  try { await operation(); await refresh(); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : "请求失败。"; }
  finally { busy.value = false; }
}
async function loadImage(event: Event, first: boolean) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = "";
  if (!file) return;
  if (file.type !== "image/png" || file.size > 9 * 1024 * 1024) { error.value = "请选择不超过 9 MB 的 PNG。"; return; }
  try {
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file);
    });
    const bitmap = await createImageBitmap(file);
    frameShapes.value[first ? "first" : "last"] = `${bitmap.width}×${bitmap.height}`; bitmap.close();
    if (first) { firstFrame.value = encoded; firstName.value = file.name; } else { lastFrame.value = encoded; lastName.value = file.name; }
  } catch { error.value = "图片读取失败，请重新选择。"; }
}
async function submit() {
  if (inputProblem.value) throw new Error(inputProblem.value);
  const body = JSON.stringify({ model: model.value, prompt: prompt.value, width: width.value, height: height.value, frames: frames.value, seed: seed.value, quickGeneration: quickGeneration.value, generateAudio: generateAudio.value, ...(mode.value === "reference" ? { references: references.value.map(asset => asset.id), referenceVideoSound: referenceVideoSound.value } : {}), ...(mode.value === "image" && firstFrame.value ? { firstFrame: firstFrame.value } : {}), ...(mode.value === "image" && lastFrame.value ? { lastFrame: lastFrame.value } : {}) });
  if (!pendingSubmission || pendingSubmission.body !== body) pendingSubmission = { body, key: crypto.randomUUID() };
  const result = await request<Job>("/jobs", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": pendingSubmission.key }, body });
  activeVideo.value.jobId = result.id; selectedId.value = result.id; filter.value = "all"; search.value = ""; notice.value = "已加入生成队列。";
  pendingSubmission = undefined;
}
type SavedCanvas = { version: 1; items: CanvasItem[]; active: string; selected: string[]; positions: Record<string, {x:number;y:number}>; drafts: [string, ReturnType<typeof captureDraft>][]; audio: [string, Blob][] };
const draftLoaded = ref(true);
const draftStatus = ref("正在恢复草稿…");
const draftFailure = ref("");
let draftRevision = 0;
let savingDraft = false;
let pendingDraft: SavedCanvas | undefined;
const projectId = ref(new URL(location.href).searchParams.get("project") || "");
const projectTitle = ref("未命名项目");
const projectHome = ref(!projectId.value);
const projects = ref<{id:string;title:string;updatedAt:string;cardCount:number}[]>([]);
async function loadProjects() { projects.value = (await request<{projects: typeof projects.value}>("/projects")).projects; }
async function openProject(id: string) {
  if (savingDraft) return;
  projectId.value = id; projectHome.value = false; draftLoaded.value = false;
  const url=new URL(location.href);url.searchParams.set("project",id);history.replaceState(null,"",url);
  await restoreCanvasDraft();
}
async function createProject() {
  const project=await request<{id:string}>("/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:crypto.randomUUID()})});
  await openProject(project.id);
  pendingDraft = canvasRecord(); await saveCanvasDraft();
}
async function showProjects() {
  await saveCanvasDraft();
  if (savingDraft || draftFailure.value) return;
  projectHome.value = true;
  const url=new URL(location.href);url.searchParams.delete("project");history.replaceState(null,"",url);
  await loadProjects();
}
function canvasRecord(): SavedCanvas {
  const allDrafts = new Map(drafts);
  allDrafts.set(activeVideoId.value, captureDraft());
  const items = JSON.parse(JSON.stringify(canvasItems.value)) as CanvasItem[];
  const audio: [string, Blob][] = [];
  for (const item of items) {
    item.audioBusy = false;
    if (item.audioUrl?.startsWith("blob:")) {
      const blob = generatedAudio.get(item.audioUrl);
      if (blob) audio.push([item.id, blob]);
      delete item.audioUrl;
    }
  }
  return { version: 1, items, active: activeVideoId.value, selected: [...selectedIds.value], positions: JSON.parse(JSON.stringify(canvas.positions.value)), drafts: JSON.parse(JSON.stringify([...allDrafts])), audio };
}
async function saveCanvasDraft() {
  if (savingDraft || draftFailure.value) return;
  savingDraft = true;
  try {
    while (pendingDraft) {
      const value = pendingDraft; pendingDraft = undefined;
      draftRevision = await writeDraft(projectId.value, value, draftRevision, projectTitle.value);
    }
    draftStatus.value = "已保存到此浏览器";
  } catch (failure) {
    draftFailure.value = failure instanceof Error ? failure.message : "草稿保存失败。";
    draftStatus.value = "保存失败";
  } finally { savingDraft = false; }
}
watch(() => [captureDraft(), canvasItems.value, canvas.positions.value, activeVideoId.value, selectedIds.value, projectTitle.value], () => {
  if (!draftLoaded.value || projectHome.value || !projectId.value || draftFailure.value) return;
  pendingDraft = canvasRecord(); draftStatus.value = "保存中…";
  void saveCanvasDraft();
}, { deep: true, flush: "post" });
async function restoreCanvasDraft() {
  try {
    draftFailure.value = "";
    const record = await readDraft<SavedCanvas>(projectId.value);
    draftRevision = record.revision; projectTitle.value = record.title;
    if (record.value) {
      const value = record.value;
      if (value.version !== 1 || !Array.isArray(value.items) || !value.items.some(item => item.id === value.active && item.kind === "video")) throw new Error("草稿格式无法识别，原草稿已保留。");
      draftRevision = record.revision;
      canvasItems.value = value.items;
      canvas.positions.value = value.positions;
      drafts.clear(); for (const [id, draft] of value.drafts) drafts.set(id, draft);
      for (const [id, blob] of value.audio || []) {
        const item = canvasItems.value.find(row => row.id === id);
        if (item) { const url = URL.createObjectURL(blob); generatedAudio.set(url, blob); item.audioUrl = url; }
      }
      // Restore through the existing parameter owner without overwriting the saved active draft.
      activeVideoId.value = "";
      const wasBusy = busy.value; busy.value = false;
      selectCanvasVideo(canvasItems.value.find(item => item.id === value.active)!);
      busy.value = wasBusy;
      drafts.delete("");
      selectedIds.value = value.selected.filter(id => value.items.some(item => item.id === id));
      selectedCanvasId.value = selectedIds.value[0] || value.active;
      canvas.center(value.active);
    }
    if (!record.value) {
      drafts.clear(); canvasItems.value = [{id:"draft-1",kind:"video",title:"视频 1",text:""}];
      canvas.positions.value={};canvas.add("draft-1");
      activeVideoId.value=""; const wasBusy=busy.value;busy.value=false;selectCanvasVideo(canvasItems.value[0]!);busy.value=wasBusy;drafts.delete("");
      selectedIds.value=["draft-1"];selectedCanvasId.value="draft-1";canvas.center("draft-1");
    }
  } catch (failure) {
    draftFailure.value = failure instanceof Error ? failure.message : "草稿恢复失败，原内容未覆盖。";
    draftStatus.value = "恢复失败";
  } finally { await nextTick(); draftLoaded.value = true; }
}
function protectUnsavedDraft(event: BeforeUnloadEvent) {
  if (savingDraft || pendingDraft || draftFailure.value) { event.preventDefault(); event.returnValue = ""; }
}
onMounted(() => { if (projectId.value) { draftLoaded.value=false; void restoreCanvasDraft(); } else void action(loadProjects); window.addEventListener("beforeunload", protectUnsavedDraft); });
onBeforeUnmount(() => window.removeEventListener("beforeunload", protectUnsavedDraft));
onMounted(() => {
  void loadAudioModels();
  void action(refresh);
  events = managerEventSource("/api/events");
  events.addEventListener("plugin_event", event => {
    try {
      const payload = JSON.parse((event as MessageEvent).data);
      const value = payload.data?.instanceId ? payload.data : payload;
      if (value.instanceId !== "manager:video") return;
      if (value.name === "video.models") { if (showModels.value) void refreshModels().catch(() => { error.value = "无法更新模型状态。"; }); return; }
      if (value.name === "video.progress") {
        const job = snapshot.value?.jobs.find(item => item.id === value.data.jobId);
        if (job) job.progress = value.data.progress;
      } else if (value.name === "video.changed") void refresh().catch(() => { error.value = "任务状态更新失败，请刷新。"; });
    } catch { error.value = "任务事件读取失败，请刷新。"; }
  });
  events.onopen = () => { void refresh().catch(() => { error.value = "无法读取视频服务状态。"; }); };
});
onBeforeUnmount(() => { disposed = true; events?.close(); for (const url of generatedAudio.keys()) URL.revokeObjectURL(url); generatedAudio.clear(); });
</script>

<template>
  <v-theme-provider theme="dark" with-background class="video-page">
    <v-overlay :model-value="!draftLoaded" persistent class="align-center justify-center">正在恢复草稿…</v-overlay>
    <section v-if="projectHome" class="project-home">
      <h1>我的项目</h1>
      <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
      <div class="project-grid">
        <button class="project-tile project-new" :disabled="busy" @click="action(createProject)"><v-icon icon="mdi-plus" size="30" /><span>新建项目</span></button>
        <button v-for="project in projects" :key="project.id" class="project-tile" :disabled="busy" @click="action(()=>openProject(project.id))"><div class="project-cover"><v-icon icon="mdi-movie-open-outline" size="44" /></div><strong>{{ project.title }}</strong><small>{{ project.cardCount }} 张卡片 · {{ new Date(project.updatedAt).toLocaleString() }}</small></button>
      </div>
    </section>
    <div v-show="!projectHome">
    <div class="video-heading workspace-heading">
      <v-btn icon="mdi-arrow-left" variant="text" aria-label="我的项目" @click="action(showProjects)" />
      <input v-model="projectTitle" class="project-title" aria-label="项目名称" maxlength="100" />
      <div><h1>媒体工作台</h1><span>{{ snapshot ? (snapshot.online ? '服务已就绪' : '服务未启动') : '正在连接' }}</span></div>

      <v-btn variant="text" size="small" prepend-icon="mdi-cube-outline" @click="action(openModels)">模型管理</v-btn>
      <v-switch :model-value="snapshot?.online || false" :loading="busy" :disabled="busy || !snapshot || installing" hide-details color="primary" aria-label="视频生成服务开关" @update:model-value="value => action(() => request(value ? '/runtime/start' : '/runtime/stop', { method: 'POST' }))" />
    </div>
    <v-alert v-if="draftFailure" type="error" variant="tonal">{{ draftFailure }}</v-alert>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-dialog v-model="showModels" max-width="760">
      <v-card title="媒体模型管理" class="pa-4">
        <v-card-text>
          <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
          <v-text-field v-model="modelDirectory" label="模型目录" :placeholder="directories?.defaultModelRoot" hint="留空使用默认目录。修改目录不会移动已有模型。" persistent-hint :disabled="busy || installing || snapshot?.online" />
          <p v-if="directories" class="video-hint">当前目录：{{ directories.effectiveModelRoot }}</p>
          <v-btn variant="outlined" :disabled="busy || installing || snapshot?.online || !directories" @click="action(saveDirectory)">保存目录</v-btn>
          <v-divider class="my-5" />
          <div class="video-heading"><strong>媒体运行环境</strong><v-btn :disabled="busy || installing || snapshot?.online || management?.runtimeInstalled" @click="action(() => install('/models/runtime'))">{{ management?.runtimeInstalled ? '已安装' : '安装运行环境' }}</v-btn></div>
          <p class="video-hint">需要 NVIDIA CUDA 显卡。首次安装会下载 Python、ComfyUI 和推理依赖。</p>
          <div v-for="item in management?.models || []" :key="item.id" class="video-heading"><div><strong>{{ item.label }}</strong><p>{{ (item.bytes / 1024 ** 3).toFixed(1) }} GiB · {{ item.installed ? '已下载' : '未下载完整' }}</p></div><v-btn :disabled="busy || installing || snapshot?.online || item.installed" @click="action(() => install(`/models/${item.id}/download`))">{{ item.installed ? '已下载' : '下载模型' }}</v-btn></div>
          <v-progress-linear v-if="installing" :model-value="management?.job?.total ? management.job.bytes / management.job.total * 100 : 0" :indeterminate="!management?.job?.total" color="primary" />
          <p v-if="management?.job" role="status">{{ management.job.state === 'running' ? '正在安装，请保持程序运行' : management.job.state === 'completed' ? '安装完成' : management.job.message }}</p>
          <p v-if="snapshot?.online" class="video-hint">停止视频服务后可以修改目录或安装。</p>
        </v-card-text>
        <v-card-actions><v-btn @click="action(refreshModels)">刷新状态</v-btn><v-spacer /><v-btn @click="showModels = false">关闭</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <div ref="viewport" class="video-workspace" :class="{'canvas-dragging':dragging,'canvas-hand':handMode}" :style="canvasGrid" @contextmenu="openCanvasMenu" @pointerdown.capture="dismissCanvasPopovers" @pointerdown="canvas.backgroundDown($event); contextMenu=undefined" @pointermove="canvas.move" @pointerup="canvas.end" @pointercancel="canvas.end" @lostpointercapture="canvas.end" @wheel="canvas.wheel" @keydown.esc="showLibrary=false; contextMenu=undefined; openPopover=''">
      <nav class="workspace-tools" aria-label="创作工具"><button aria-label="添加画布卡片" @click="openCanvasMenu"><v-icon icon="mdi-plus" size="23" /></button><button :class="{active:showLibrary}" :aria-expanded="showLibrary" aria-controls="video-history-panel" aria-label="作品历史" @click="showLibrary=!showLibrary"><v-icon icon="mdi-history" size="23" /></button><button aria-label="模型管理" @click="action(openModels)"><v-icon icon="mdi-cube-outline" size="23" /></button></nav>
      <div class="canvas-world" :style="canvasTransform">
      <div v-if="marquee" class="canvas-selection-box" :style="{left:marquee.x+'px',top:marquee.y+'px',width:marquee.width+'px',height:marquee.height+'px'}" />
      <article v-for="item in otherItems" :key="item.id" class="canvas-object canvas-card" :class="{'canvas-selected':selectedIds.includes(item.id)}" :style="canvas.position(item.id)" @pointerdown="cardPointerDown($event,item)" @contextmenu="openCardMenu($event,item)">
        <button class="canvas-drag-handle" :aria-label="`移动${item.title}`" @click="selectCard(item)" @keydown="canvas.nudge($event,item.id)"><v-icon :icon="canvasKinds.find(row=>row.kind===item.kind)?.icon" size="16" />{{ item.title }}<v-icon icon="mdi-drag" size="16" /></button>
        <div v-if="item.kind==='video'" class="canvas-video-card">
          <video v-if="canvasVideoUrl(item)" class="passive-video" :src="canvasVideoUrl(item)" preload="metadata" />
          <div v-else class="canvas-card-empty"><v-icon icon="mdi-video-outline" size="32" /><span>上传或生成视频</span><label class="card-upload-button" @pointerdown.stop>上传视频<input type="file" accept="video/mp4" :aria-label="`上传${item.title}`" :disabled="busy || uploading" @change="uploadCanvasAsset($event,item)" /></label></div>
        </div>
        <div v-else-if="item.kind==='text'" class="canvas-text-card"><p class="node-text-preview">{{ item.text || '添加文本内容…' }}</p></div>
        <div v-else class="canvas-media-card">
          <img v-if="item.kind==='image' && imageSource(item)" draggable="false" :src="imageSource(item)" :alt="item.title" />
          <div v-else-if="item.kind==='audio' && audioSource(item)" class="canvas-card-empty"><v-icon icon="mdi-music-note-outline" size="32" /><audio :src="audioSource(item)" controls preload="metadata" :aria-label="`播放${item.title}`" @pointerdown.stop /></div>
          <div v-else class="canvas-card-empty"><v-icon :icon="item.kind==='image' ? 'mdi-image-outline' : 'mdi-music-note-outline'" size="32" /><span>{{ item.kind==='audio' ? '上传或生成音频' : '上传或生成图片' }}</span><label class="card-upload-button" @pointerdown.stop>上传{{ item.kind==='audio' ? '音频' : '图片' }}<input type="file" :accept="item.kind==='audio' ? '.wav,audio/wav' : 'image/png'" :aria-label="`上传${item.title}`" :disabled="busy || uploading" @change="uploadCanvasAsset($event,item)" /></label></div>
          <label v-if="imageSource(item) || (item.kind==='audio' && audioSource(item))" class="card-replace-upload card-upload-button" @pointerdown.stop>替换<input type="file" :accept="item.kind==='audio' ? '.wav,audio/wav' : 'image/png'" :aria-label="`替换${item.title}`" :disabled="busy || uploading" @change="uploadCanvasAsset($event,item)" /></label>
        </div>
        <section v-if="item.kind!=='video' && selectedIds.length===1 && selectedIds.includes(item.id)" class="composer node-editor" :class="{'audio-node-editor':item.kind==='audio'}" :aria-label="`${item.title}编辑`" @pointerdown.stop @contextmenu.stop>
          <template v-if="item.kind==='text'">
            <textarea v-model="item.text" :aria-label="`${item.title}内容`" placeholder="写下镜头、台词或创作笔记…" />
            <button class="canvas-card-action" :disabled="!item.text.trim()" @click="prompt += (prompt ? '\n' : '') + item.text; selectCard(activeVideo); canvas.center(activeVideoId)">加入视频提示词</button>
          </template>
          <template v-else>
            <template v-if="item.kind==='image'">
              <button v-if="imageSource(item)" class="canvas-card-action" @click="action(()=>useGeneratedImage(item))">用作视频参考</button>
              <textarea v-model="item.text" :aria-label="`${item.title}生成提示词`" placeholder="描述你想生成的画面…" />
              <div class="image-generation-controls">
                <span class="image-mode-label"><v-icon icon="mdi-image-outline" size="15" />图片生成</span>
                <v-menu :model-value="openPopover===`image-model-${item.id}`" @update:model-value="updatePopover(`image-model-${item.id}`,$event)" location="bottom start" offset="8"><template #activator="{props}"><button v-bind="props" class="media-picker" aria-label="选择图片模型">{{ imageModels.find(row=>row.id===item.imageModel)?.label || imageModels[0]?.label || '选择模型' }}<v-icon icon="mdi-chevron-down" size="16" /></button></template>
                  <div class="media-model-menu" role="menu" aria-label="图片模型列表"><button v-for="option in imageModels" :key="option.id" role="menuitemradio" :aria-checked="(item.imageModel || imageModels[0]?.id)===option.id" @click="item.imageModel=option.id"><span><strong>{{ option.label }}</strong><small>本地文生图 · 快速生成场景与创作草图</small></span><v-icon v-if="(item.imageModel || imageModels[0]?.id)===option.id" icon="mdi-check" size="17" /></button><button class="model-manage-link" @click="action(openModels)">管理模型与下载<v-icon icon="mdi-arrow-top-right" size="15" /></button></div>
                </v-menu>
                <v-menu :model-value="openPopover===`image-format-${item.id}`" @update:model-value="updatePopover(`image-format-${item.id}`,$event)" location="top" offset="8" :close-on-content-click="false"><template #activator="{props}"><button v-bind="props" class="media-picker" aria-label="图片比例与清晰度"><v-icon icon="mdi-rectangle-outline" size="16" />{{ imageRatio(item).label }} / {{ imageQuality(item) }}<v-icon icon="mdi-chevron-down" size="16" /></button></template>
                  <div class="image-format-menu"><div class="format-label">比例</div><div class="image-ratio-segments"><button v-for="ratio in imageRatios" :key="ratio.label" :class="{active:imageRatio(item).label===ratio.label}" :aria-label="`图片比例 ${ratio.label}`" :aria-pressed="imageRatio(item).label===ratio.label" @click="setImageFormat(item,ratio)"><span :style="{width:(ratio.w>=ratio.h ? 17 : 17*ratio.w/ratio.h)+'px',height:(ratio.h>=ratio.w ? 17 : 17*ratio.h/ratio.w)+'px'}" />{{ ratio.label }}</button></div><div class="format-label">清晰度 <small>{{ (item.imageSize || '1024x1024').replace('x',' × ') }}</small></div><div class="image-quality-segments"><button v-for="quality in ['480P','720P','1K','2K']" :key="quality" :class="{active:imageQuality(item)===quality}" :aria-pressed="imageQuality(item)===quality" @click="setImageFormat(item,imageRatio(item),quality)">{{ quality }}</button></div></div>
                </v-menu>
                <span class="image-single-count">×1</span>
                <v-btn class="image-generate-arrow" icon="mdi-arrow-up" size="x-small" color="white" aria-label="生成图片" :disabled="busy || uploading || !snapshot?.online || !item.text.trim() || !imageModels.length || (imageJob(item) && !snapshot?.states[imageJob(item)!.status]?.terminal)" @click="action(()=>generateImage(item))" />
              </div>
              <p v-if="imageJob(item)" role="status">{{ snapshot?.states[imageJob(item)!.status]?.label }} {{ imageJob(item)?.error }}</p>
            </template>
            <template v-if="item.kind==='audio'">

              <div v-if="item.audioMode!=='reference'" class="audio-text-tools"><v-menu v-for="group in audioInsertGroups" :key="group.id" :model-value="openPopover===`audio-${group.id}-${item.id}`" @update:model-value="updatePopover(`audio-${group.id}-${item.id}`,$event)" location="bottom start" offset="6"><template #activator="{props}"><button v-bind="props" class="media-picker audio-text-picker" :aria-label="group.label" :disabled="item.audioBusy">{{ group.label }}<v-icon icon="mdi-chevron-down" size="14" /></button></template><div class="media-model-menu audio-insert-menu" role="menu" :aria-label="`${group.label}选项`"><button v-for="option in group.items" :key="option.label" role="menuitem" @click="insertAudioText(item,option.text)"><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button></div></v-menu></div>
              <AudioPromptEditor v-if="item.audioMode!=='reference'" :ref="el=>{if(el)audioEditors.set(item.id,el as InstanceType<typeof AudioPromptEditor>);else audioEditors.delete(item.id);}" v-model="item.text" :label="`${item.title}合成文字`" :disabled="item.audioBusy" />

              <div class="image-generation-controls audio-toolbar"><v-menu :model-value="openPopover===`audio-mode-${item.id}`" @update:model-value="updatePopover(`audio-mode-${item.id}`,$event)" location="top start" offset="8"><template #activator="{props}"><button v-bind="props" class="media-picker" aria-label="音频功能" :disabled="item.audioBusy"><v-icon icon="mdi-music-note-outline" size="15" />{{ item.audioMode==='reference' ? '音频参考' : '音频生成' }}<v-icon icon="mdi-chevron-down" size="16" /></button></template><div class="media-model-menu" role="menu" aria-label="音频功能选项"><button role="menuitemradio" :aria-checked="item.audioMode!=='reference'" @click="item.audioMode='generate'"><span><strong>音频生成</strong><small>将文字合成为语音</small></span></button><button role="menuitemradio" :aria-checked="item.audioMode==='reference'" @click="item.audioMode='reference'"><span><strong>音频参考</strong><small>上传、试听并用于视频生成</small></span></button></div></v-menu>
                <v-menu v-if="item.audioMode!=='reference'" :model-value="openPopover===`audio-model-${item.id}`" @update:model-value="updatePopover(`audio-model-${item.id}`,$event)" location="bottom start" offset="8"><template #activator="{props}"><button v-bind="props" class="media-picker audio-model-picker" aria-label="选择音频模型" :title="`选择 TTS 模型（${audioModels.length} 个）`">{{ audioModels.find(row=>row.id===(item.audioModel || audioModels.find(row=>row.available)?.id))?.name || '选择 TTS 模型' }}<v-icon icon="mdi-chevron-down" size="16" /></button></template><div class="media-model-menu audio-model-menu" role="menu" aria-label="音频模型列表"><button v-for="option in audioModels" :key="option.id" role="menuitemradio" :aria-checked="(item.audioModel || audioModels.find(row=>row.available)?.id)===option.id" :disabled="item.audioBusy" @click="selectAudioModel(item,option)"><span><strong>{{ option.name }}</strong><small>{{ option.note || option.family }} · {{ option.available ? '可用' : '未就绪' }}</small></span><v-icon v-if="selectedAudioModel(item)?.id===option.id" icon="mdi-check" size="17" /></button><p v-if="!audioModels.length" class="audio-catalog-message">{{ audioCatalogError || '正在读取模型…' }}</p><button @click="loadAudioModels">刷新模型列表</button></div></v-menu>
                <button v-if="item.audioMode!=='reference'" class="media-picker" :class="{active:item.audioSettingsOpen}" aria-label="音频参数设置" :aria-expanded="!!item.audioSettingsOpen" :aria-controls="`audio-settings-${item.id}`" @click="item.audioSettingsOpen=!item.audioSettingsOpen;openPopover='';if(item.audioSettingsOpen)loadAudioModels()">参数设置<v-icon :icon="item.audioSettingsOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="16" /></button>
                <a v-if="audioSource(item)" class="media-picker" :href="audioSource(item)" :download="`${item.title}.wav`" aria-label="下载音频"><v-icon icon="mdi-download" size="16" /></a>
                <v-btn v-if="item.audioMode!=='reference'" class="generate-button" color="white" size="x-small" icon="mdi-arrow-up" aria-label="生成音频" :loading="item.audioBusy" :disabled="item.audioBusy || !item.text.trim() || !audioModels.some(row=>row.available && row.id===(item.audioModel || audioModels.find(row=>row.available)?.id))" @click="generateAudioCard(item)" />
              </div>
              <TtsModelParameters v-if="item.audioSettingsOpen && item.audioMode!=='reference'" :id="`audio-settings-${item.id}`" class="audio-settings-panel" :model="selectedAudioModel(item)" :model-value="audioParameterValues(item)" @update:model-value="item.audioParameters=$event" :disabled="item.audioBusy" />
              <p v-if="selectedAudioModel(item) && !selectedAudioModel(item)?.available" class="audio-catalog-message">所选模型尚未就绪，可先配置参数。</p>
              <p v-if="item.audioError || audioCatalogError" class="audio-catalog-message" role="status">{{ item.audioError || audioCatalogError }}</p>
              <button v-if="audioSource(item)" class="canvas-card-action" :disabled="busy || uploading || item.audioBusy" @click="action(()=>useAudioReference(item))">用作视频参考</button>
            </template>
          </template>
        </section>
      </article>
      <div class="creation-stage canvas-object" :class="{'canvas-selected':selectedIds.includes(activeVideoId)}" :style="canvas.position(activeVideoId)" @pointerdown="cardPointerDown($event,activeVideo)" @contextmenu="openCardMenu($event,activeVideo)">
        <button class="canvas-drag-handle" :aria-label="`移动${activeVideo.title}`" @click="selectCard(activeVideo)" @keydown="canvas.nudge($event,activeVideoId)"><v-icon icon="mdi-video-outline" size="16" />{{ activeVideo.title }}<v-icon icon="mdi-drag" size="16" /></button>
        <div class="preview-stage">
          <video v-if="canvasVideoUrl(activeVideo)" :key="activeVideo.id" :src="canvasVideoUrl(activeVideo)" controls preload="metadata" @pointerdown.stop />
          <div v-else class="preview-empty"><v-icon :icon="selected ? 'mdi-movie-open-outline' : 'mdi-play-box-outline'" size="32" /><h2>{{ selected ? snapshot?.states[selected.status]?.label || selected.status : '让想象成为镜头' }}</h2><p>{{ selected?.error || (selected ? '生成结果会出现在这里' : '从一段描述或参考素材开始') }}</p><label v-if="!selected" class="card-upload-button" @pointerdown.stop>上传视频<input type="file" accept="video/mp4" aria-label="上传当前视频素材" :disabled="busy || uploading" @change="uploadCanvasAsset($event,activeVideo)" /></label><v-progress-linear v-if="selected?.status==='running'" :model-value="selected.progress*100" :indeterminate="!selected.progress" color="primary" /></div>
        </div>
        <div v-if="selected" class="result-details"><div class="result-actions"><v-chip size="small" variant="tonal">{{ snapshot?.states[selected.status]?.label || selected.status }}</v-chip><span class="video-hint">{{ selected.width }} × {{ selected.height }} · {{ ((selected.frames || 0)/24).toFixed(2) }} 秒</span><v-spacer /><v-btn v-if="selected.videoUrl" :href="managerResourceUrl(selected.videoUrl)" :download="`${selected.id}.mp4`" variant="outlined" size="small" prepend-icon="mdi-download">下载</v-btn><v-btn variant="text" size="small" @click="copyPrompt(selected)">复制提示词</v-btn><v-btn variant="tonal" size="small" @click="reuse(selected)">复用参数</v-btn><v-btn v-if="selected.status==='queued'" variant="text" size="small" :disabled="busy" @click="cancelSelected">取消排队</v-btn></div><details class="result-prompt"><summary>生成提示词</summary><p class="video-prompt">{{ selected.prompt }}</p></details></div>
      <section v-show="selectedIds.length===1 && selectedIds.includes(activeVideoId)" class="composer" aria-label="视频创作">

        <div class="mode-tabs" role="group" aria-label="生成模式">
          <button v-for="tab in [{id:'text',label:'文生视频'},{id:'image',label:'首尾帧'},{id:'reference',label:'多模态参考'}]" :key="tab.id" :class="{active:mode===tab.id}" :aria-pressed="mode===tab.id" @click="setMode(tab.id)">{{ tab.label }}</button>
        </div>
        <div class="composer-body">
          <div v-if="mode === 'image'" class="frame-pair">
            <div v-for="first in [true,false]" :key="String(first)" class="frame-slot">
              <label class="upload-tile">
                <img v-if="first ? firstFrame : lastFrame" :src="`data:image/png;base64,${first ? firstFrame : lastFrame}`" :alt="first ? '首帧预览' : '尾帧预览'" />
                <v-icon v-else icon="mdi-image-plus-outline" size="28" />
                <strong>{{ first ? '添加首帧' : '添加尾帧' }}</strong>
                <small>{{ first ? frameShapes.first || 'PNG · 最大 9 MB' : frameShapes.last || '可选 · PNG' }}</small>
                <input type="file" accept="image/png" :aria-label="first ? '上传首帧' : '上传尾帧'" @change="event => loadImage(event, first)" />
              </label>
              <button v-if="first ? firstFrame : lastFrame" class="text-action" @click="clearImage(first)">移除{{ first ? '首帧' : '尾帧' }}</button>
            </div>
          </div>
          <v-btn v-if="mode==='image' && firstFrame && lastFrame" variant="text" size="small" prepend-icon="mdi-swap-horizontal" @click="swapFrames">交换首尾帧</v-btn>
          <section v-if="mode==='reference'" class="reference-section" aria-label="参考素材">
            <div class="reference-add">
              <label v-for="kind in referenceKinds" :key="kind.id" class="reference-upload"><v-icon :icon="kind.icon" size="20" />{{ kind.label }}<input type="file" :accept="kind.accept" multiple :disabled="uploading" :aria-label="`添加${kind.label}`" @change="event => uploadReferences(event, kind.id)" /></label>
            </div>
            <details class="asset-help"><summary>素材要求</summary><p class="video-hint">图片最多 9 张 PNG，每张 9 MB；视频最多 3 段 24 FPS、2–15 秒 MP4，每段 64 MB；音频最多 3 段不超过 15 秒的 WAV，每段 16 MB。</p></details>
            <v-progress-linear v-if="uploading" indeterminate color="primary" />
            <div class="reference-grid">
            <article v-for="(asset,index) in references" :key="asset.id" class="reference-card" :class="{wide:asset.kind!=='image'}">
              <img v-if="asset.kind==='image'" :src="managerResourceUrl(`/api/video/assets/${asset.id}`)" :alt="referenceLabel(asset)" />
              <video v-else-if="asset.kind==='video'" :src="managerResourceUrl(`/api/video/assets/${asset.id}`)" controls preload="metadata" />
              <audio v-else :src="managerResourceUrl(`/api/video/assets/${asset.id}`)" controls preload="metadata" />
              <div class="reference-caption"><button class="text-action" @click="prompt += ` ${referenceLabel(asset)} `">{{ referenceLabel(asset) }} ↗</button><span>{{ asset.duration ? `${asset.duration.toFixed(1)} 秒` : `${asset.width}×${asset.height}` }}</span><button class="text-action" :aria-label="`移除${referenceLabel(asset)}`" @click="removeReference(index)">移除</button></div>
              <button v-if="asset.kind==='video' && asset.hasAudio && referenceVideoSound" class="text-action" @click="prompt += ` ${videoSoundLabel(asset)} `">原声 {{ videoSoundLabel(asset) }} ↗</button>
            </article>
            </div>
            <v-checkbox v-if="references.some(a=>a.kind==='video' && a.hasAudio)" :model-value="referenceVideoSound" label="使用参考视频的原声" hide-details density="compact" @update:model-value="setVideoSound" />
          </section>
          <v-textarea v-model="prompt" label="描述你想生成的画面" :placeholder="mode==='text' ? '主体、动作、场景与镜头运动…' : '描述素材如何参与生成，以及想要的动作和镜头…'" rows="3" max-rows="5" auto-grow variant="plain" :maxlength="12000" hide-details />

        </div>
        <div class="composer-toolbar">
          <span class="image-mode-label"><v-icon icon="mdi-video-outline" size="15" />视频生成</span>
          <span class="media-picker">MiniMax H3</span>
          <v-menu :model-value="openPopover==='video-format'" @update:model-value="updatePopover('video-format',$event)" :close-on-content-click="false" location="top" offset="8" max-width="400">
            <template #activator="{ props }"><button v-bind="props" class="media-picker" aria-label="视频参数"><v-icon icon="mdi-rectangle-outline" size="16" />{{ selectedRatio?.label || `${width}×${height}` }} / {{ duration }}s / {{ selectedResolution?.label || '自定义' }}<v-icon icon="mdi-chevron-down" size="16" /></button></template>
            <v-card class="parameter-popover"><v-card-text>
          <div class="duration-control">
            <div class="field-label"><span>时长</span><output>{{ duration }} 秒</output></div>
            <v-slider v-model="frames" :min="22" :max="260" :step="17" aria-label="视频时长" :aria-valuetext="`${duration} 秒`" color="white" track-color="grey-darken-2" thumb-size="14" hide-details thumb-label><template #thumb-label="{ modelValue }">{{ (modelValue / 24).toFixed(2) }} 秒</template></v-slider>
            <div class="duration-bounds"><span>0.92 秒</span><span>10.83 秒</span></div>
          </div>
          <div><div class="field-label">比例 <span>{{ width }} × {{ height }}</span></div><div class="ratio-options"><button v-for="ratio in ratios" :key="ratio.label" :class="{active:selectedRatio?.label===ratio.label}" :aria-pressed="selectedRatio?.label===ratio.label" @click="applyRatio(ratio)"><span class="ratio-shape" :style="{aspectRatio:`${ratio.width}/${ratio.height}`}" />{{ ratio.label }}</button></div></div>
          <div class="resolution-control">
            <div class="field-label"><span>清晰度</span><span>{{ selectedResolution?.label || '自定义' }}</span></div>
            <div class="resolution-options"><button v-for="item in resolutions" :key="item.edge" :class="{active:selectedResolution?.edge===item.edge}" :aria-pressed="selectedResolution?.edge===item.edge" :disabled="!resolutionAllowed(item.edge)" @click="applyResolution(item.edge)">{{ item.label }}</button></div>

          </div>

            </v-card-text></v-card>
          </v-menu>
          <v-btn size="small" variant="text" :prepend-icon="generateAudio ? 'mdi-volume-high' : 'mdi-volume-off'" :aria-pressed="generateAudio" @click="generateAudio=!generateAudio">{{ generateAudio ? '生成声音' : '无声' }}</v-btn>
          <v-btn size="small" variant="text" :aria-pressed="quickGeneration" :disabled="!selectedWorkflow" prepend-icon="mdi-lightning-bolt" @click="quickGeneration=!quickGeneration">{{ quickGeneration ? '快速' : '标准' }}</v-btn>
          <v-btn class="generate-button" size="small" color="white" icon="mdi-arrow-up" aria-label="生成视频" :disabled="busy || uploading || !snapshot?.online || !prompt.trim() || !!inputProblem" :loading="busy" @click="action(submit)" />
        </div>
        <div class="generate-feedback" role="status"><p v-if="inputProblem" class="input-warning">{{ inputProblem }}</p><p v-else-if="!snapshot?.online" class="video-hint">请先启动顶部的视频服务。</p><p v-else-if="!prompt.trim()" class="video-hint">写下提示词，开始创作。</p></div>
      </section>
      </div>
      </div>
      <aside v-if="showLibrary" id="video-history-panel" class="output-library" aria-label="我的作品">
        <div class="library-toolbar"><h2>我的作品 <span>{{ snapshot?.jobs.length || 0 }}</span></h2><v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭作品历史" @click="showLibrary=false" /><v-btn variant="text" size="small" prepend-icon="mdi-refresh" :disabled="busy" @click="action(refresh)">刷新</v-btn></div>
        <div class="library-filters"><v-select v-model="filter" :items="[{title:'全部',value:'all'},{title:'进行中',value:'pending'},{title:'已完成',value:'succeeded'},{title:'失败',value:'failed'}]" label="状态" hide-details density="compact" variant="outlined" /><v-text-field v-model="search" label="搜索提示词" prepend-inner-icon="mdi-magnify" hide-details density="compact" variant="outlined" clearable /></div>
        <p v-if="!filteredJobs.length" class="library-empty">{{ snapshot?.jobs.length ? '没有匹配的作品' : '生成的视频将保存在这里' }}</p>
        <div class="video-library"><button v-for="job in filteredJobs" :key="job.id" class="work-card" :class="{selected: selected?.id===job.id}" :aria-pressed="selected?.id===job.id" @click="addJobToCanvas(job)"><div class="work-thumbnail"><img v-if="job.imageUrl" :src="managerResourceUrl(job.imageUrl)" alt="生成图片" /><video v-else-if="job.videoUrl" :src="managerResourceUrl(job.videoUrl)" muted preload="metadata" tabindex="-1" /><v-icon v-else icon="mdi-movie-open-outline" size="30" /><span class="work-status">{{ snapshot?.states[job.status]?.label || job.status }}</span></div><p>{{ job.prompt }}</p><time>{{ new Date(job.createdAt).toLocaleString() }}</time></button></div>
      </aside>
      <div v-if="contextMenu" class="canvas-menu" role="menu" aria-label="画布右键菜单" :style="{left:contextMenu.x+'px',top:contextMenu.y+'px'}" @pointerdown.stop>
        <template v-if="contextMenu.itemId">
          <button role="menuitem" :disabled="busy || uploading" @click="duplicateCard(false)"><v-icon icon="mdi-content-copy" size="17" />复制节点</button>
          <button role="menuitem" :disabled="busy || uploading" @click="duplicateCard(true)"><v-icon icon="mdi-content-duplicate" size="17" />克隆空节点</button>
          <button role="menuitem" @click="exportCard"><v-icon icon="mdi-export-variant" size="17" />导出节点参数</button>
          <hr /><button role="menuitem" class="delete-node" :disabled="busy || uploading" @click="deleteCard"><v-icon icon="mdi-trash-can-outline" size="17" />删除节点</button>
        </template>
        <template v-else>
        <button v-for="entry in canvasKinds" :key="entry.kind" role="menuitem" :disabled="busy || uploading" @click="addCanvasItem(entry.kind)"><v-icon :icon="entry.icon" size="17" />添加{{ entry.label }}卡片</button>
        <hr /><button role="menuitem" @click="showLibrary=true; contextMenu=undefined"><v-icon icon="mdi-history" size="17" />从作品历史添加</button><button role="menuitem" @click="canvas.fit(); contextMenu=undefined"><v-icon icon="mdi-fit-to-screen-outline" size="17" />适应画布</button>
        </template>
      </div>
      <aside class="canvas-minimap" aria-label="画布小地图" @pointerdown.stop @contextmenu.stop @wheel.stop>
        <button class="minimap-toggle" :aria-expanded="minimapOpen" aria-controls="canvas-minimap-map" @click="minimapOpen=!minimapOpen"><span>小地图</span><span>{{ minimapOpen ? '−' : '+' }}</span></button>
        <svg v-if="minimapOpen" id="canvas-minimap-map" viewBox="0 0 180 110" role="img" aria-label="点击小地图移动视野" @click="navigateMinimap">
          <rect v-for="card in minimap.cards" :key="card.id" v-bind="{x:card.x,y:card.y,width:card.width,height:card.height}" :class="['minimap-card',{'minimap-selected':selectedIds.includes(card.id)}]" />
          <rect v-bind="minimap.view" class="minimap-viewport" />
        </svg>
      </aside>
      <nav class="canvas-tools" aria-label="画布视图"><button :class="{active:!handMode}" :aria-pressed="!handMode" aria-label="选择模式" @click="handMode=false"><v-icon icon="mdi-cursor-default-outline" size="20" /></button><button :class="{active:handMode}" :aria-pressed="handMode" aria-label="拖动画布模式" @click="handMode=true"><v-icon icon="mdi-hand-back-right-outline" size="20" /></button><span class="tool-divider" /><button aria-label="缩小画布" @click="canvas.zoom(scale/1.2)">−</button><button class="zoom-label" aria-label="复位画布视图" @click="resetCanvasView">{{ Math.round(scale*100) }}%</button><button aria-label="放大画布" @click="canvas.zoom(scale*1.2)">+</button><button aria-label="适应画布" @click="canvas.fit"><v-icon icon="mdi-fit-to-screen-outline" size="20" /></button></nav>
    </div>
    <v-snackbar v-model="noticeVisible" timeout="4000">{{ notice }}</v-snackbar>
  </div>
  </v-theme-provider>
</template>

<style scoped>
.video-page { --rr-text:#ededed; --rr-muted:#9b9b9f; --rr-border:#ffffff20; --rr-primary:#aaa4dc; --rr-panel:#19191b; position:relative; width:100%; height:calc(100dvh - var(--v-layout-top, 0px) - var(--video-shell-offset, 0px)); min-height:540px; margin:0; padding:0; color:var(--rr-text); background:#0e0e10 !important; overflow:hidden; color-scheme:dark; }
.video-heading { display:flex; align-items:center; gap:16px; margin-bottom:20px; }
.video-heading>div:first-child { margin-right:auto; }
.video-heading h1 { font-size:24px; }
.video-heading span,.video-hint,small,time { color:var(--rr-muted); }
.video-workspace { position:absolute; inset:64px 0 0; overflow:hidden; touch-action:none; background-image:radial-gradient(#ffffff15 .8px,transparent .8px); background-size:24px 24px; }
.creation-stage { position:absolute; width:640px; display:flex; flex-direction:column; align-items:center; }
.preview-stage { flex-shrink:0; width:min(380px,100%); height:214px; background:#232325; border:1px solid #ffffff35; border-radius:10px; overflow:hidden; display:flex; align-items:center; justify-content:center; color:#e7e7ed; box-shadow:0 12px 40px #0003; }
.preview-stage>video { width:100%; height:100%; object-fit:contain; }
.preview-empty { text-align:center; max-width:80%; color:#b4b4c2; }
.preview-empty h2 { font-size:14px; margin:12px 0 8px; color:#ddd; font-weight:500; }
.preview-empty p { font-size:12px; margin-bottom:12px; }
.result-details { width:100%; padding:10px 6px 0; }
.result-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:2px; opacity:.8; }
.result-prompt { margin-top:8px; font-size:12px; }
summary { cursor:pointer; }
.video-prompt { white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; line-height:1.7; margin-top:8px; max-height:140px; overflow:auto; }
.composer { width:100%; margin-top:14px; border:1px solid #ffffff22; border-radius:18px; background:#19191bf5; box-shadow:0 16px 50px #0005; }
.mode-tabs { display:flex; padding:10px 12px 0; gap:6px; }
.mode-tabs button { padding:8px 12px; border:1px solid #ffffff12; border-radius:9px; font-size:12px; color:#aaa; }
.active { background:#ffffff12; color:#fff !important; box-shadow:inset 0 0 0 1px #ffffff28; }
.composer-body { padding:10px 14px 4px; display:grid; grid-template-columns:minmax(0,1fr); gap:8px; }
.composer-toolbar { display:flex; align-items:center; gap:2px; flex-wrap:wrap; padding:8px 10px 10px; }
.model-picker { min-width:0; max-width:100%; }
.generate-button { margin-left:auto; flex-shrink:0; }
.generate-feedback { padding:0 16px; }
.video-hint,.input-warning { font-size:12px; line-height:1.6; margin:0 0 12px; }
.input-warning { color:var(--rr-text); }
.parameter-popover { --rr-muted:#aaa; --rr-border:#ffffff20; width:min(330px,calc(100vw - 24px)); border:1px solid #454545; border-radius:24px !important; background:#191919 !important; box-shadow:0 14px 40px #0005; }
.parameter-popover :deep(.v-card-title) { font-size:14px; padding:14px 16px 4px; }
.parameter-popover :deep(.v-card-text) { display:grid; gap:14px; padding:14px 9px 9px; }
.field-label { display:flex; justify-content:space-between; font-size:13px; margin-bottom:10px; }
.field-label span { color:var(--rr-muted); }
.duration-bounds { display:flex; justify-content:space-between; color:#999; font-size:11px; }
.resolution-options { display:flex; gap:2px; padding:4px; background:#242424; border-radius:12px; }
.resolution-options button { flex:1; min-height:30px; border:0; border-radius:8px; color:#888; font-size:12px; }
.resolution-options button:disabled { opacity:.35; cursor:not-allowed; }
.resolution-hint { color:#aaa; font-size:11px; line-height:1.6; margin:8px 0 0; }
.ratio-options { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:2px; padding:4px; background:#242424; border-radius:14px; }
.ratio-options button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; border:0; border-radius:8px; min-height:54px; font-size:10px; color:#888; }
.ratio-shape { display:inline-block; height:12px; border:1px solid currentColor; border-radius:2px; }
.advanced summary { font-size:14px; padding:8px 0; }
.video-parameters { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px; }
.frame-pair { display:grid; grid-template-columns:repeat(2,minmax(0,128px)); gap:8px; }
.upload-tile { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; min-height:80px; border:1px dashed #ffffff30; border-radius:9px; overflow:hidden; cursor:pointer; }
.upload-tile img { width:100%; height:72px; object-fit:contain; }
.upload-tile strong { font-size:13px; }
.upload-tile small { font-size:12px; padding-bottom:8px; }
.upload-tile input,.reference-upload input { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; }
.upload-tile:focus-within,.reference-upload:focus-within,button:focus-visible,summary:focus-visible { outline:2px solid var(--rr-primary,#9c8cff); outline-offset:3px; }
.text-action { font-size:12px; padding:8px 2px; min-height:36px; text-decoration:underline; }
.reference-add { display:flex; gap:8px; }
.reference-upload { position:relative; display:flex; align-items:center; justify-content:center; gap:6px; border:1px dashed #ffffff30; border-radius:8px; min-width:72px; min-height:42px; font-size:12px; }
.asset-help { font-size:12px; color:var(--rr-muted); margin:8px 0; }
.asset-help p { margin-top:8px; }
.reference-grid { display:flex; gap:10px; overflow-x:auto; padding:4px 2px; }
.reference-card { flex:0 0 140px; min-width:0; border:1px solid #ffffff20; border-radius:9px; padding:6px; }
.reference-card.wide { flex-basis:240px; }
.reference-card img,.reference-card video { width:100%; height:80px; object-fit:contain; background:#101015; border-radius:6px; }
.reference-card audio { width:100%; height:80px; }
.reference-caption { display:flex; justify-content:space-between; align-items:center; gap:4px; flex-wrap:wrap; font-size:11px; }
.output-library { position:absolute; top:14px; left:72px; bottom:16px; z-index:5; width:min(310px,calc(100% - 88px)); padding:18px; background:#18181bf5; border:1px solid #ffffff20; border-radius:18px; box-shadow:12px 16px 50px #0008; display:flex; flex-direction:column; min-height:0; }
.library-toolbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.library-toolbar h2 { font-size:17px; }
.library-toolbar h2 span { font-size:12px; color:var(--rr-muted); margin-left:8px; }
.library-filters { display:grid; gap:12px; margin-bottom:16px; }
.video-library { display:grid; gap:12px; overflow-y:auto; padding:2px; min-height:0; }
.work-card { min-width:0; text-align:left; border:1px solid var(--rr-border,#7774); border-radius:12px; overflow:hidden; padding-bottom:12px; }
.work-card.selected { border-color:var(--rr-primary,#9c8cff); box-shadow:0 0 0 1px var(--rr-primary,#9c8cff); }
.work-thumbnail { aspect-ratio:16/9; background:#15151b; position:relative; display:flex; align-items:center; justify-content:center; color:#aaa; }
.work-thumbnail video { width:100%; height:100%; object-fit:cover; pointer-events:none; }
.work-status { position:absolute; bottom:8px; left:8px; padding:3px 7px; background:#15151bcc; color:#eee; border-radius:5px; font-size:11px; }
.work-card p { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; padding:10px 12px 4px; font-size:13px; }
.work-card time { padding:0 12px; font-size:11px; }
.library-empty { padding:24px 8px; text-align:center; color:var(--rr-muted); font-size:14px; }
.workspace-heading { height:64px; padding:0 24px; margin:0; gap:10px; }
.workspace-heading>div:first-child { display:flex; align-items:center; gap:14px; }
.workspace-heading h1 { font-size:16px; font-weight:600; }
.workspace-heading span { font-size:11px; }
.workspace-heading :deep(.v-switch) { flex:0 0 auto; }
.workspace-tools { position:absolute; z-index:6; left:16px; top:50%; transform:translateY(-50%); display:grid; gap:4px; padding:6px; border:1px solid #ffffff20; border-radius:24px; background:#1c1c1ef0; }
.workspace-tools button { width:36px; height:40px; border-radius:18px; color:#ccc; }
.composer :deep(.v-field__input) { font-size:13px; line-height:1.7; }
.composer :deep(.v-field__field) { --v-field-padding-top:0px; }
.composer-toolbar :deep(.v-btn) { font-size:11px; letter-spacing:0; }
.composer-toolbar :deep(.v-btn:not(.v-btn--icon)) { padding-inline:8px; }
.result-actions :deep(.v-btn) { font-size:10px; letter-spacing:0; padding-inline:7px; min-width:0; }
.result-actions :deep(.v-chip) { font-size:10px; height:22px; }
.result-actions .video-hint { margin:0; font-size:10px; }
.result-prompt { font-size:10px; color:#999; text-align:center; }
.result-prompt p { text-align:left; }
.video-page>.v-alert { position:absolute; top:64px; left:72px; right:16px; z-index:8; }
.generate-feedback p { font-size:11px; margin-bottom:10px; }
.asset-help { font-size:10px; }
@media(max-width:600px) {
  .workspace-heading { padding:0 12px; }
  .workspace-heading>div:first-child { display:block; }


  .workspace-tools { left:10px; }
  .mode-tabs { padding:8px 8px 0; gap:3px; }
  .mode-tabs button { flex:1; padding:8px 4px; font-size:11px; }
  .composer-body { padding:8px; }
  .composer-toolbar { padding:6px; }
  .reference-upload { min-width:0; flex:1; }
  .result-actions .video-hint { display:none; }
  .output-library { left:60px; width:calc(100% - 72px); }
}

.canvas-world { position:absolute; inset:0; transform-origin:0 0; pointer-events:none; }
.canvas-object { pointer-events:auto; }
.canvas-selection-box { position:absolute; border:1px solid #aaa; background:#ffffff12; pointer-events:none; z-index:10; }
.canvas-card,.preview-stage { cursor:pointer; }
.passive-video { pointer-events:none; }
.canvas-selected > .canvas-video-card,.canvas-selected > .canvas-media-card,.canvas-selected > .canvas-text-card,.canvas-selected > .preview-stage { outline:1px solid #bbb; box-shadow:0 0 0 3px #ffffff0d; }
.canvas-card { position:absolute; width:380px; margin-left:130px; }
.canvas-drag-handle { display:flex; align-items:center; gap:8px; min-height:34px; width:380px; max-width:100%; color:#ddd; font-size:13px; cursor:pointer; text-align:left; touch-action:none; }
.canvas-drag-handle .v-icon:last-child { margin-left:auto; opacity:.5; }
.canvas-video-card,.canvas-media-card,.canvas-text-card { border:1px solid #ffffff30; border-radius:12px; background:#232325; overflow:hidden; }
.canvas-video-card>video,.canvas-media-card>img { display:block; width:100%; height:214px; object-fit:contain; }
.canvas-media-card>audio { width:100%; margin-top:24px; }
.canvas-card-empty { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; height:214px; color:#aaa; font-size:13px; }
.canvas-card-empty input,.canvas-upload-video input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.canvas-card-action { display:block; width:100%; padding:12px; font-size:12px; border-top:1px solid #ffffff18; background:#ffffff08; }
.canvas-text-card textarea { width:100%; height:200px; resize:vertical; padding:16px; outline:none; color:#eee; font-size:14px; background:transparent; }
.canvas-upload-video { position:relative; display:inline-block; padding:7px 14px; border-radius:20px; background:#eee; color:#222; font-size:12px; margin-bottom:10px; }
.canvas-menu { position:absolute; z-index:10; width:200px; padding:8px; border:1px solid #ffffff25; border-radius:16px; background:#1b1b1e; box-shadow:0 12px 40px #0008; }
.canvas-menu button { display:flex; gap:10px; align-items:center; width:100%; min-height:40px; padding:8px 10px; text-align:left; font-size:13px; border-radius:8px; }
.canvas-menu button:hover { background:#ffffff12; }
.canvas-menu hr { border:0; border-top:1px solid #ffffff18; margin:5px; }
.canvas-tools { position:absolute; z-index:7; bottom:18px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:4px; padding:6px; border:1px solid #ffffff20; border-radius:26px; background:#1b1b1ef5; box-shadow:0 8px 28px #0006; }
.canvas-tools button { min-width:34px; height:34px; border-radius:18px; font-size:20px; }
.canvas-tools .zoom-label { min-width:58px; font-size:12px; }
.tool-divider { height:18px; border-left:1px solid #ffffff20; margin:0 4px; }
.canvas-hand { cursor:grab; }
.canvas-dragging,.canvas-dragging .canvas-card,.canvas-dragging .preview-stage,.canvas-dragging .canvas-drag-handle { cursor:grabbing; user-select:none; }
</style>

<style scoped>
.canvas-menu .delete-node { color:#f16c6c; }
.canvas-minimap { position:absolute; left:16px; bottom:18px; width:180px; z-index:7; border:1px solid #ffffff20; border-radius:8px; overflow:hidden; background:#202023ee; }
.minimap-toggle { display:flex; width:100%; justify-content:space-between; align-items:center; padding:5px 9px; color:#aaa; font-size:11px; cursor:pointer; }
.canvas-minimap svg { display:block; width:100%; height:110px; cursor:pointer; background:#161618; }
.minimap-card { fill:#626268; }
.minimap-selected { fill:#b0b0b8; }
.minimap-viewport { fill:#ffffff0c; stroke:#a9a9b1; stroke-width:1; pointer-events:none; }
@media(max-width:640px) { .canvas-minimap { width:125px; bottom:76px; left:10px; } .canvas-minimap svg { height:auto; } }
</style>

<style scoped>
.node-text-preview { height:214px; margin:0; padding:16px; white-space:pre-wrap; overflow:hidden; color:#ddd; font-size:14px; user-select:none; }
.node-editor { width:640px; margin:14px 0 0 -130px; padding:16px; cursor:default; }
.node-editor textarea { display:block; width:100%; min-height:130px; resize:vertical; padding:8px; background:transparent; color:#eee; outline:none; cursor:text; }
.node-editor audio { display:block; width:100%; margin:0; color-scheme:dark; }
.audio-node-editor {width:560px;margin-left:-90px;padding:12px;border-radius:20px;background:#141414;}
.audio-node-editor .audio-prompt-editor {min-height:90px;}
.audio-node-editor .media-picker {padding:5px 7px;}
.audio-node-editor .audio-text-tools {margin:0 0 8px;}
.audio-settings-panel {margin-top:24px;padding:0 0 8px;cursor:default;}
.audio-settings-heading {display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.audio-settings-panel h3 {font-size:12px;font-weight:600;color:#ddd;margin:0;}
.audio-reset {display:flex;align-items:center;gap:4px;color:#777;font-size:12px;cursor:pointer;}
.audio-reset:hover {color:#eee;}
.audio-voice-tabs {display:flex;gap:4px;margin-bottom:8px;}
.audio-voice-tabs button {border-radius:5px;background:#242424;color:#888;font-size:12px;padding:3px 10px;cursor:pointer;}
.audio-voice-tabs button.active {background:#eee;color:#222;}
.audio-voice-selected {display:flex;align-items:center;gap:8px;background:#242424;border-radius:8px;padding:9px 12px;font-size:13px;color:#ddd;}
.audio-settings-panel .audio-section-title {margin:18px 0 8px;}
.audio-slider-row {display:flex;align-items:center;gap:10px;min-height:28px;font-size:12px;color:#999;}
.audio-slider-row .v-slider {flex:1;margin:0;}
.audio-slider-row output {min-width:35px;text-align:right;font-variant-numeric:tabular-nums;}
.audio-parameter-note {font-size:11px;color:#777;margin:10px 0 0;}
.audio-text-tools {display:flex;gap:6px;margin:10px 0;}
.audio-text-picker {border:1px solid #ffffff20;border-radius:16px;padding:4px 10px;color:#aaa;}
.audio-insert-menu {width:220px;}
.audio-catalog-message {font-size:12px;color:#999;padding:8px 4px;margin:0;line-height:1.5;}
.media-model-menu button:disabled {opacity:.4;cursor:not-allowed;}
.audio-duration {font-size:12px;color:#888;}
.audio-upload-description strong,.audio-upload-description small {display:block;}
.audio-upload-description strong {font-size:12px;font-weight:500;color:#ddd;}
.audio-upload-description small {font-size:11px;color:#888;margin-top:5px;}
.audio-listening-area {min-height:110px;display:flex;align-items:center;padding:14px 4px;}
.audio-listening-area p {font-size:13px;color:#888;margin:0;}
.audio-reference-button {display:flex;align-items:center;gap:6px;margin-left:auto;background:#eee;color:#191919;padding:8px 12px;border-radius:18px;font-size:12px;cursor:pointer;}
.audio-reference-button:disabled {opacity:.35;cursor:not-allowed;}
.audio-info-menu dl {margin:0;padding:4px;background:#242424;border-radius:14px;}
.audio-info-menu dl>div {display:flex;justify-content:space-between;gap:16px;padding:10px;font-size:12px;}
.audio-info-menu dt {color:#888;}
.audio-info-menu dd {margin:0;color:#eee;}
.node-upload { position:relative; display:inline-flex; padding:8px 14px; border:1px solid #ffffff30; border-radius:18px; font-size:12px; cursor:pointer; overflow:hidden; }
.node-upload input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.node-video-controls { padding:10px 14px 0; }
.node-video-controls video { display:block; width:100%; max-height:180px; margin-bottom:8px; }
.canvas-media-card img { pointer-events:none; }
</style>

<style scoped>
.image-generation-controls { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.work-thumbnail>img {width:100%;height:100%;object-fit:cover;}
</style>

<style scoped>
.image-generation-controls { gap:4px; margin:12px 0 0; flex-wrap:wrap; }
.image-mode-label {display:flex;align-items:center;gap:6px;font-size:12px;color:#eee;margin-right:6px;}
.media-picker {display:inline-flex;align-items:center;gap:7px;padding:7px 9px;border-radius:8px;color:#eee;font-size:12px;cursor:pointer;white-space:nowrap;}
.media-picker:hover,.media-picker[aria-expanded="true"] {background:#ffffff0d;}
.image-single-count {margin-left:auto;color:#aaa;font-size:12px;padding:0 8px;}
.image-generate-arrow {margin-left:4px;}
.media-model-menu,.image-format-menu {background:#171719;color:#eee;border:1px solid #ffffff20;border-radius:24px;box-shadow:0 14px 40px #0005;padding:9px;width:360px;max-width:calc(100vw - 24px);}
.audio-model-picker {background:#242424;border:1px solid #ffffff12;border-radius:10px;min-height:34px;}
.audio-model-picker:hover,.audio-model-picker[aria-expanded="true"] {background:#333;}
.audio-model-menu {max-height:min(480px,calc(100dvh - 32px));overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;}
.audio-model-menu>button[aria-checked="true"] {background:#ffffff09;}
.media-model-menu>button {display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:12px 10px;border-radius:9px;text-align:left;cursor:pointer;}
.media-model-menu>button:hover {background:#ffffff08;}
.media-model-menu strong {display:block;font-size:13px;font-weight:500;}
.media-model-menu small {display:block;font-size:11px;line-height:1.5;color:#85858b;margin-top:5px;}
.media-model-menu .model-manage-link {font-size:11px;color:#aaa;border-top:1px solid #ffffff0a;border-radius:0;margin-top:5px;}
.image-format-menu {width:330px;padding:12px 9px 9px;background:#191919;border-color:#454545;overflow:hidden;}
.format-label {display:flex;justify-content:space-between;font-size:12px;padding:0 4px;margin-bottom:9px;}
.format-label small {color:#777;font-size:10px;}
.image-ratio-segments {display:flex;gap:2px;background:#242424;padding:4px;border-radius:14px;margin-bottom:14px;}
.image-ratio-segments button {display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:8px;height:54px;border-radius:8px;color:#777;font-size:10px;cursor:pointer;}
.image-ratio-segments button>span {display:block;border:1px solid currentColor;border-radius:2px;}
.image-ratio-segments button.active,.image-quality-segments button.active {background:#3a3a3a;color:#fff;}
.image-quality-segments {display:flex;background:#242424;padding:4px;border-radius:12px;}
.node-reference-row {display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.image-upload-tile {width:48px;height:48px;align-items:center;justify-content:center;padding:0;border-style:dashed;border-radius:10px;color:#888;}
.ratio-options button.active,.resolution-options button.active {background:#3a3a3a;color:#fff;}
.media-picker:focus-visible,.media-model-menu button:focus-visible,.image-format-menu button:focus-visible,.parameter-popover button:focus-visible {outline:2px solid #aaa;outline-offset:2px;}
.image-quality-segments button {flex:1;padding:7px;border-radius:8px;color:#777;font-size:12px;cursor:pointer;}
</style>

<style scoped>
.project-home { padding:48px; min-height:90vh; background:#0b0b0c; }
.project-home h1 { font-size:22px; margin-bottom:30px; }
.project-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:20px; max-width:1100px; }
.project-tile { min-height:210px; border:1px solid #333; border-radius:18px; background:#171718; padding:16px; text-align:left; display:flex; flex-direction:column; gap:10px; color:#eee; }
.project-tile:hover { border-color:#777; }
.project-new { border-style:dashed; align-items:center; justify-content:center; }
.project-cover { background:#252527; height:130px; border-radius:12px; display:grid; place-items:center; color:#666; }
.project-tile small { color:#999; font-size:12px; }
.project-title { color:inherit; max-width:210px; padding:8px; outline:none; }
</style>

<style scoped>
.canvas-media-card,.preview-stage { position:relative; }
.card-upload-button { position:relative; display:inline-flex; align-items:center; justify-content:center; background:#f4f4f4; color:#171717; padding:7px 16px; border-radius:22px; font-size:13px; cursor:pointer; overflow:hidden; }
.card-upload-button input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.card-replace-upload { position:absolute; right:10px; top:10px; opacity:0; }
.canvas-media-card:hover .card-replace-upload,.card-replace-upload:focus-within { opacity:1; }
.canvas-card-empty audio { width:88%; }
</style>
