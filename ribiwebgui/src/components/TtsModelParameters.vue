<script setup lang="ts">
import {computed,onMounted,ref,watch} from "vue";
import {speechControlClient} from "../speech/speechControlClient";
import type {SpeechModel,SpeechPersona} from "@shared/speechControlContract";
import {ttsCapabilities,ttsSystemVoices,normalizeTtsParameters,ttsEmotions,type TtsParameters} from "../speech/ttsParameters";
const props=defineProps<{model?:SpeechModel;modelValue:TtsParameters;disabled?:boolean}>();
const emit=defineEmits<{"update:modelValue":[value:TtsParameters]}>();
const systemSearch=ref("");
const systemVoices=computed(()=>ttsSystemVoices(props.model));
const filteredSystemVoices=computed(()=>systemVoices.value.filter(row=>row.name.toLocaleLowerCase().includes(systemSearch.value.trim().toLocaleLowerCase())));
const caps=computed(()=>ttsCapabilities(props.model));
const values=computed(()=>normalizeTtsParameters(props.model,props.modelValue));
function update(patch:TtsParameters){emit("update:modelValue",normalizeTtsParameters(props.model,{...values.value,...patch}));}
const voices=ref<SpeechPersona[]>([]);
const voiceError=ref(false);
const voiceTab=ref<"system"|"mine">("system");
const voicesLoading=ref(false);
async function refreshVoices(){if(voicesLoading.value)return;voicesLoading.value=true;voiceError.value=false;try{voices.value=(await speechControlClient.personas()).personas.filter(row=>row.voiceReady);}catch{voiceError.value=true;}finally{voicesLoading.value=false;}}
watch(()=>props.model?.id,()=>{voiceTab.value=values.value.voice && values.value.voice!=="default" && caps.value.cloneVoice ? "mine" : "system";});
onMounted(()=>{if(values.value.voice && values.value.voice!=="default" && caps.value.cloneVoice)voiceTab.value="mine";void refreshVoices();});
const styles=[{label:"自然",value:""},{label:"轻柔",value:"用轻柔、自然的语气说话。"},{label:"活泼",value:"用活泼、轻快的语气说话。"},{label:"沉稳",value:"用沉稳、清晰的语气说话。"}];
function languageName(code:string){try{return new Intl.DisplayNames(["zh"],{type:"language"}).of(code)||code;}catch{return code;}}
function reset(){voiceTab.value="system";emit("update:modelValue",normalizeTtsParameters(props.model));}
</script>
<template><section class="tts-parameters" aria-label="音频详细参数">
 <header><h3>音色设置</h3><button :disabled="disabled" @click="reset"><v-icon icon="mdi-restore" size="14" />一键重置</button></header>
 <p v-if="!model" class="hint">请先选择 TTS 模型。</p>
 <template v-else>
 <div v-if="caps.voice" class="voice-setting">
  <div class="voice-tabs" role="tablist" aria-label="音色分类"><button role="tab" :aria-selected="voiceTab==='system'" :class="{active:voiceTab==='system'}" :disabled="disabled" @click="voiceTab='system'">系统音色</button><button v-if="caps.cloneVoice" role="tab" :aria-selected="voiceTab==='mine'" :class="{active:voiceTab==='mine'}" :disabled="disabled" @click="voiceTab='mine'">我的音色</button></div>
  <div v-if="voiceTab==='system'" class="voice-system-row">
   <v-menu v-if="caps.fixedVoice" location="bottom start" offset="6" :close-on-content-click="false"><template #activator="{props:activator}"><button v-bind="activator" class="voice-picker" :disabled="disabled" aria-label="选择系统音色"><v-icon icon="mdi-waveform" size="18" /><span>{{ systemVoices.find(voice=>voice.id===values.voice)?.name || '模型默认音色' }}</span><v-icon icon="mdi-chevron-down" size="16" /></button></template><template #default="{isActive}"><div class="language-menu voice-list" aria-label="系统音色列表"><input v-model="systemSearch" class="voice-search" aria-label="搜索系统音色" placeholder="搜索音色" @keydown.stop /><button role="menuitemradio" :aria-checked="values.voice==='default'" @click="update({voice:'default'});isActive.value=false">模型默认音色</button><button v-for="voice in filteredSystemVoices" :key="voice.id" role="menuitemradio" :aria-checked="values.voice===voice.id" @click="update({voice:voice.id});isActive.value=false"><span>{{ voice.name }}</span><v-icon v-if="values.voice===voice.id" icon="mdi-check" size="15" /></button><p v-if="!systemVoices.length" class="hint">音色列表暂不可用，请刷新模型列表。</p><p v-else-if="!filteredSystemVoices.length" class="hint">没有匹配的音色</p></div></template></v-menu>
   <button v-else class="voice-picker" :disabled="disabled" :aria-pressed="values.voice==='default'" @click="update({voice:'default'})"><v-icon icon="mdi-waveform" size="18" /><span>模型默认音色</span><v-icon v-if="values.voice==='default'" icon="mdi-check" size="16" /></button>
  </div>
  <template v-else>
   <div v-if="voicesLoading" class="voice-empty" role="status">正在读取音色…</div>
   <div v-else-if="voiceError" class="voice-empty" role="status"><span>音色列表暂不可用</span><button @click="refreshVoices">重新加载</button></div>
   <div v-else-if="!voices.length" class="voice-empty"><span>暂无已配置音色</span><button @click="refreshVoices">刷新音色</button></div>
   <v-menu v-else location="bottom start" offset="6"><template #activator="{props:activator}"><button v-bind="activator" class="voice-picker" :disabled="disabled" aria-label="选择我的音色"><v-icon icon="mdi-waveform" size="18" /><span>{{ voices.find(voice=>voice.id===values.voice)?.id || '选择音色' }}</span><v-icon icon="mdi-chevron-down" size="16" /></button></template><div class="language-menu voice-list" role="menu" aria-label="我的音色列表"><button v-for="voice in voices" :key="voice.id" role="menuitemradio" :aria-checked="values.voice===voice.id" @click="update({voice:voice.id})"><span>{{ voice.id }}</span><v-icon v-if="values.voice===voice.id" icon="mdi-check" size="15" /></button></div></v-menu>
  </template>
 </div>
 <h3 v-if="caps.speed || caps.language" class="section-title">基础调节</h3>
 <div v-if="caps.speed" class="slider-row"><label>语速</label><v-slider :model-value="values.speed" @update:model-value="update({speed:$event})" :min="caps.speed.min" :max="caps.speed.max" :step="0.05" color="white" track-color="grey-darken-2" thumb-size="14" hide-details :disabled="disabled" aria-label="音频语速" /><output>{{ values.speed?.toFixed(2) }}</output></div>
 <div v-if="caps.language" class="language-field"><label>语言</label><v-menu location="bottom start" offset="6"><template #activator="{props:activator}"><button v-bind="activator" :disabled="disabled">{{ values.language ? languageName(values.language) : '自动识别' }}<v-icon icon="mdi-chevron-down" size="14" /></button></template><div class="language-menu" role="menu"><button role="menuitemradio" :aria-checked="!values.language" @click="update({language:undefined})">自动识别</button><button v-for="language in caps.languages" :key="language" role="menuitemradio" :aria-checked="values.language===language" @click="update({language})">{{ languageName(language) }}</button></div></v-menu></div>
 <template v-if="caps.emotion"><h3 class="section-title" title="控制整段语音的情绪基调；上方语气词标签用于局部表达。">整体情绪</h3><div class="emotions" role="group" aria-label="整体情绪"><button v-for="emotion in ttsEmotions" :key="emotion" :disabled="disabled" :class="{active:values.emotion===emotion}" :aria-pressed="values.emotion===emotion" @click="update({emotion})">{{ emotion }}</button></div></template>
 <template v-if="caps.instructions && !caps.emotion"><h3 class="section-title">说话风格</h3><div class="emotions" role="group" aria-label="说话风格"><button v-for="style in styles" :key="style.label" :disabled="disabled" :class="{active:(values.instructions || '')===style.value}" :aria-pressed="(values.instructions || '')===style.value" @click="update({instructions:style.value})">{{ style.label }}</button></div></template>
 </template>
</section></template>
<style scoped>
.voice-search {position:sticky;top:0;display:block;width:100%;background:#242424;color:#eee;padding:9px;border-radius:8px;margin-bottom:4px;outline:none;}
.voice-tabs {display:flex;gap:4px;margin:0 0 8px;}
.voice-tabs button {padding:3px 10px;border-radius:5px;background:#242424;color:#888;font-size:12px;line-height:16px;cursor:pointer;}
.voice-tabs button.active {background:#f4f4f4;color:#222;}
.voice-empty {display:flex;min-height:76px;flex-direction:column;justify-content:space-between;gap:14px;padding:12px;border-radius:8px;background:#222;color:#888;font-size:12px;}
.voice-empty button {align-self:center;color:#ddd;font-size:12px;cursor:pointer;}
.voice-list {width:280px;}.voice-list>button {display:flex;justify-content:space-between;gap:12px;}
.voice-picker span {flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.voice-picker {display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:#242424;border-radius:8px;color:#ddd;font-size:12px;cursor:pointer;}.voice-picker .v-icon:last-child {margin-left:auto;}
.tts-parameters {padding:0 0 4px;color:#ddd;font-size:12px;}header {display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}h3 {font-size:12px;font-weight:600;margin:0;}header button {display:flex;align-items:center;gap:4px;color:#777;font-size:11px;cursor:pointer;}.section-title {margin:16px 0 7px;}.voice-setting>label {display:block;color:#999;font-size:11px;margin-bottom:6px;}.voice-setting input,.tts-parameters textarea {width:100%;border:0;border-radius:8px;background:#242424;color:#ddd;padding:8px 10px;font-size:12px;outline:none;}.voice-setting small,.hint {display:block;color:#888;font-size:11px;margin-top:5px;}.slider-row {display:flex;align-items:center;gap:8px;height:25px;color:#999;}.slider-row .v-slider {flex:1;margin:0;}.slider-row output {min-width:32px;text-align:right;font-variant-numeric:tabular-nums;}.emotions {display:flex;flex-wrap:wrap;gap:6px;}.emotions button {padding:1px 8px;border:1px solid #ffffff28;border-radius:14px;color:#bbb;font-size:12px;cursor:pointer;}.emotions button.active {background:#eee;color:#222;border-color:#eee;}.tts-parameters textarea {min-height:56px;resize:vertical;}.language-field {display:flex;align-items:center;gap:12px;margin-top:10px;}.language-field button {background:#242424;border-radius:6px;padding:4px 10px;color:#ddd;}.language-menu {background:#191919;border:1px solid #ffffff22;border-radius:16px;padding:6px;max-height:260px;overflow:auto;min-width:140px;}.language-menu button {display:block;width:100%;text-align:left;padding:7px 10px;border-radius:8px;color:#ddd;font-size:12px;}.language-menu button:hover {background:#333;}button:disabled {opacity:.4;cursor:not-allowed;}
</style>
