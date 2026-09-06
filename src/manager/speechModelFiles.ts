import fs from "node:fs";
import path from "node:path";

export type ModelFileSpec = {
  alias: string;
  family: string;
  kind: string;
  target: string;
  repository?: string;
  download_mode?: string;
};

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
function rows(value: unknown): JsonObject[] { return Array.isArray(value) ? value.map(object) : []; }
export function readModelJson(filename: string): JsonObject {
  try {
    if (fs.statSync(filename).size > 2 * 1024 * 1024) return {};
    return object(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch { return {}; }
}
function nonemptyFile(filename: string): boolean {
  try { const stat = fs.statSync(filename); return stat.isFile() && stat.size > 0; } catch { return false; }
}
function directoryEntries(root: string): fs.Dirent[] {
  try { return fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
}

// This is evidence of downloaded files, not a checksum or inference readiness claim.
// Never recurse across arbitrary directories: inspect only a model root and known HF snapshots.
function transformerWeights(root: string): boolean {
  const indexes = ["model.safetensors.index.json", "pytorch_model.bin.index.json"];
  for (const index of indexes) {
    if (!fs.existsSync(path.join(root, index))) continue;
    const shards = Object.values(object(readModelJson(path.join(root, index)).weight_map));
    return shards.length > 0 && shards.every(shard => typeof shard === "string"
      && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:safetensors|bin)$/.test(shard)
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(shard)
      && nonemptyFile(path.join(root, shard)));
  }
  return ["model.safetensors", "pytorch_model.bin", "model.bin", "model.pt"].some(name => nonemptyFile(path.join(root, name)));
}
function modelDirectoryPresent(root: string, model: ModelFileSpec): boolean {
  const has = (name: string) => nonemptyFile(path.join(root, name));
  switch (model.family.toLowerCase()) {
    case "qwen3-tts": return ["config.json", "tokenizer_config.json", "vocab.json", "merges.txt", "speech_tokenizer/config.json"].every(has)
      && transformerWeights(root) && transformerWeights(path.join(root, "speech_tokenizer"));
    case "indextts": return ["config.yaml", "gpt.pth", "s2mel.pth", "bpe.model", "wav2vec2bert_stats.pt"].every(has);
    case "cosyvoice": return ["cosyvoice3.yaml", "llm.pt", "flow.pt", "hift.pt", "speech_tokenizer_v3.onnx"].every(has);
    case "gpt-sovits": {
      const files = directoryEntries(root);
      return files.some(file => /\.ckpt$/i.test(file.name) && has(file.name))
        && files.some(file => /^s2G.*\.pth$/i.test(file.name) && has(file.name))
        && has("chinese-hubert-base/config.json") && transformerWeights(path.join(root, "chinese-hubert-base"))
        && has("chinese-roberta-wwm-ext-large/config.json") && transformerWeights(path.join(root, "chinese-roberta-wwm-ext-large"));
    }
    case "faster-whisper": return has("config.json") && has("model.bin") && has("tokenizer.json");
    case "sensevoice": return has("config.yaml") && has("model.pt");
    default: return has("config.json") && transformerWeights(root);
  }
}
export function modelFilesPresent(root: string, model: ModelFileSpec): boolean {
  if (model.kind === "file") return nonemptyFile(root);
  const repositoryDirectory = model.repository ? `models--${model.repository.replaceAll("/", "--")}` : "";
  const sharedCache = model.download_mode === "cache";
  if (!sharedCache && modelDirectoryPresent(root, model)) return true;
  const cacheRoot = repositoryDirectory && path.basename(root) !== repositoryDirectory
    ? path.join(root, repositoryDirectory) : root;
  // Shared cache roots are never treated as one model; only its repository may match.
  for (const base of new Set(sharedCache ? [cacheRoot] : [root, cacheRoot])) {
    const snapshots = path.join(base, "snapshots");
    for (const entry of directoryEntries(snapshots).slice(0, 128)) {
      if (entry.isDirectory() && modelDirectoryPresent(path.join(snapshots, entry.name), model)) return true;
    }
  }
  return false;
}

const workerIds: Readonly<Record<string, string>> = {
  "tts-qwen3-0.6b": "qwen3-tts-0.6b-base", "tts-qwen3-1.7b": "qwen3-tts-1.7b-base",
  "tts-cosyvoice3-0.5b": "cosyvoice3-0.5b", "tts-gpt-sovits": "gpt-sovits", "tts-indextts2": "indextts2",
  "asr-qwen3-0.6b": "qwen3-asr-0.6b", "asr-qwen3-1.7b": "qwen3-asr-1.7b",
  "asr-sensevoice-small": "sensevoice-small", "asr-fireredasr2-aed": "fireredasr2-aed"
};

export function speechConfigPath(serviceRoot: string): string {
  if (process.env.RABISPEECH_CONFIG?.trim()) return path.resolve(process.env.RABISPEECH_CONFIG);
  const dataRoot = process.env.RABISPEECH_DATA_ROOT?.trim()
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "RabiPC", "RabiSpeech") : serviceRoot);
  const configured = path.join(dataRoot, "config.json");
  // start.ps1 migrates this legacy file only if the current config does not exist.
  return fs.existsSync(configured) ? configured : path.join(serviceRoot, "config.json");
}

export function configuredModelPaths(model: ModelFileSpec, configPath: string): string[] {
  const config = readModelJson(configPath);
  const providers = object(config.providers);
  const asr = object(providers.asr);
  const localTts = object(object(providers.tts).local_tts);
  const base = path.dirname(configPath);
  const result: string[] = [];
  const add = (value: unknown, relativeBase = base) => {
    if (typeof value === "string" && value.trim()) result.push(path.resolve(relativeBase, value));
  };
  const models = [...rows(localTts.models), ...rows(asr.http_providers).flatMap(provider => rows(provider.models))];
  const row = models.find(item => item.id === workerIds[model.alias]);
  if (row) {
    const command = Array.isArray(row.command) ? row.command.filter((item): item is string => typeof item === "string") : [];
    const cwd = typeof row.working_directory === "string" ? path.resolve(base, row.working_directory) : base;
    const arg = (flag: string): string | undefined => {
      const index = command.indexOf(flag);
      return index >= 0 ? command[index + 1] : undefined;
    };
    add(arg("--model"), cwd);
    if (model.alias === "tts-indextts2" && !arg("--model") && arg("--config")) add(path.dirname(arg("--config")!), cwd);
    if (model.alias === "tts-gpt-sovits" && arg("--repository-root")) {
      add(path.join(arg("--repository-root")!, "GPT_SoVITS", "pretrained_models"), cwd);
    }
  }
  if (model.family === "faster-whisper") {
    const whisper = object(asr.faster_whisper);
    const id = model.alias.replace(/^asr-whisper-/, "");
    const entry = rows(whisper.models).find(item => item.id === id);
    add(entry?.path);
    const cache = process.env.RABISPEECH_WHISPER_MODEL_ROOT || whisper.model_root;
    if (typeof cache === "string" && model.repository) add(path.join(cache, `models--${model.repository.replaceAll("/", "--")}`));
  }
  if (model.kind === "file") {
    const speaker = object(config.speaker_recognition);
    const expected = path.basename(model.target);
    const configured = process.env.RABISPEECH_SPEAKER_MODEL_PATH || speaker.model_path;
    if (typeof configured === "string" && path.basename(configured) === expected) add(configured);
  }
  return result;
}
