import type {SpeechModel} from "@shared/speechControlContract";
export type TtsParameters={voice?:string;speed?:number;language?:string;instructions?:string;emotion?:string};
type Property={minimum?:number;maximum?:number;default?:unknown;maxLength?:number};
export function ttsCapabilities(model?:SpeechModel) {
 const properties=(model?.request?.properties || {}) as Record<string,Property>;
 const features=new Set(model?.features || []);
 // Current local worker adapters consume different subsets of the shared schema.
 // Keep these compatibility limits until the provider publishes precise per-model schemas.
 const localAdapters:Record<string,{speed:boolean;language:boolean;instructions:boolean;emotion:boolean}>={
  "local-tts/indextts2":{speed:false,language:false,instructions:true,emotion:true},
  "local-tts/qwen3-tts-0.6b-base":{speed:false,language:true,instructions:false,emotion:false},
  "local-tts/qwen3-tts-1.7b-base":{speed:false,language:true,instructions:false,emotion:false},
  "local-tts/cosyvoice3-0.5b":{speed:true,language:false,instructions:true,emotion:false},
  "local-tts/gpt-sovits":{speed:true,language:true,instructions:false,emotion:false}
 };
 const adapter=localAdapters[model?.id || ""];
 const speed=adapter?.speed===false ? undefined : properties.speed;
 return {voice:!!properties.voice, fixedVoice:features.has("fixed_speakers"),cloneVoice:features.has("voice_clone"),
 speed: speed ? {min:adapter ? Math.max(.5,speed.minimum ?? .5) : speed.minimum ?? .25,max:adapter ? Math.min(2,speed.maximum ?? 2) : speed.maximum ?? 4,default:typeof speed.default==="number" ? speed.default : 1}:undefined,
 language:!!properties.language && (adapter ? adapter.language : features.has("multilingual")),languages:model?.languages || [],
 instructions:!!properties.instructions && (adapter ? adapter.instructions : features.has("instructions") || features.has("emotion_control")),
 emotion:!!properties.instructions && (adapter ? adapter.emotion : features.has("emotion_control")),instructionLimit:properties.instructions?.maxLength ?? 2000};
}
export const ttsEmotions=["无","高兴","悲伤","愤怒","害怕","厌恶","惊讶","平静"];
export function normalizeTtsParameters(model:SpeechModel|undefined,values:TtsParameters={}):TtsParameters {
 const c=ttsCapabilities(model);const result:TtsParameters={};
 if(c.voice)result.voice=values.voice?.trim() || "default";
 if(c.speed)result.speed=Math.min(c.speed.max,Math.max(c.speed.min,Number.isFinite(values.speed) ? values.speed! : c.speed.default));
 if(c.language && c.languages.includes(values.language || ""))result.language=values.language;
 if(c.instructions)result.instructions=values.instructions?.slice(0,c.instructionLimit) || "";
 if(c.emotion)result.emotion=ttsEmotions.includes(values.emotion || "") ? values.emotion : "无";
 return result;
}
export function ttsCommandSettings(model:SpeechModel,values:TtsParameters={}) {
 const c=ttsCapabilities(model),v=normalizeTtsParameters(model,values);
 const emotion=c.emotion && v.emotion && v.emotion!=="无" ? `整段语音以${v.emotion}为整体情绪基调。` : "";
 return {model:model.id,voice:v.voice || "default",speed:v.speed ?? 1,language:v.language || null,
 instructions:c.instructions ? (emotion+(v.instructions || "")).slice(0,c.instructionLimit) || null : null,
 responseFormat:"wav",sampleRate:null,play:false,sessionId:null,routeId:null};
}

export function ttsSystemVoices(model?:SpeechModel):{id:string;name:string}[] {
 const properties=model?.request?.properties as Record<string,unknown>|undefined;
 const voice=properties?.voice as {oneOf?:unknown}|undefined;
 if(!Array.isArray(voice?.oneOf))return [];
 return voice.oneOf.flatMap(value=>{
  if(!value || typeof value!=="object")return [];
  const row=value as {const?:unknown;title?:unknown};
  return typeof row.const==="string" && typeof row.title==="string" ? [{id:row.const,name:row.title}] : [];
 });
}
