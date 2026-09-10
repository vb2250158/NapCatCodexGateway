<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { splitAudioPrompt } from "../speech/audioPause";
const props=defineProps<{modelValue:string; disabled?:boolean; label:string}>();
const emit=defineEmits<{"update:modelValue":[value:string]}>();
const editor=ref<HTMLDivElement>();
let savedRange:Range|undefined;
let composing=false;
function read():string {
  const visit=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return node.textContent || "";
    if(!(node instanceof HTMLElement))return "";
    if(node.dataset.token)return node.dataset.token;
    if(node.tagName==="BR")return "\n";
    return (node.tagName==="DIV" && node.previousSibling ? "\n" : "")+Array.from(node.childNodes).map(visit).join("");
  };
  return Array.from(editor.value?.childNodes || []).map(visit).join("");
}
function chip(label:string,token:string) {
  const span=document.createElement("span");span.className="pause-chip";span.contentEditable="false";span.dataset.token=token;
  span.append(document.createTextNode(label));
  const button=document.createElement("button");button.type="button";button.textContent="×";button.setAttribute("aria-label",`移除 ${label} 标签`);
  button.addEventListener("pointerdown",event=>event.preventDefault());
  button.addEventListener("click",()=>{if(props.disabled)return;span.remove();savedRange=undefined;changed();editor.value?.focus();});
  span.append(button);return span;
}
function fragment(text:string) {
  const result=document.createDocumentFragment();
  for(const part of splitAudioPrompt(text))result.append(part.kind==="pause" ? chip(`${part.seconds}s`,`<#${part.seconds}#>`) : part.kind==="cue" ? chip(part.text,`<[${part.text}]>`) : document.createTextNode(part.text));
  return result;
}
function render() {if(editor.value){editor.value.replaceChildren(fragment(props.modelValue));savedRange=undefined;}}
function remember() {
  const selection=window.getSelection();
  if(selection?.rangeCount && editor.value?.contains(selection.getRangeAt(0).commonAncestorContainer))savedRange=selection.getRangeAt(0).cloneRange();
}
function changed() {if(!composing){emit("update:modelValue",read());remember();}}
function insert(text:string) {
  const root=editor.value;if(!root || props.disabled)return;
  if(read().length+text.length>10000)return;
  root.focus();const range=savedRange && root.contains(savedRange.commonAncestorContainer) ? savedRange : document.createRange();
  if(range!==savedRange){range.selectNodeContents(root);range.collapse(false);}
  range.deleteContents();const nodes=fragment(text);const last=nodes.lastChild;range.insertNode(nodes);
  if(last){range.setStartAfter(last);range.collapse(true);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);}
  changed();
}
function startComposition(){composing=true;}
function endComposition(){composing=false;changed();}
function paste(event:ClipboardEvent) {event.preventDefault();insert(event.clipboardData?.getData("text/plain") || "");}
watch(()=>props.modelValue,()=>{if(!composing && read()!==props.modelValue)render();});
onMounted(render);defineExpose({insert});
</script>
<template><div ref="editor" class="audio-prompt-editor" :contenteditable="!disabled" role="textbox" aria-multiline="true" :aria-label="label" :aria-disabled="disabled" data-placeholder="输入要合成的文字…" @input="changed" @keyup="remember" @mouseup="remember" @blur="remember" @paste="paste" @drop.prevent @compositionstart="startComposition" @compositionend="endComposition" /></template>
<style scoped>
.audio-prompt-editor {min-height:110px;padding:8px 0;color:#ddd;font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;outline:none;cursor:text;}
.audio-prompt-editor:empty:before {content:attr(data-placeholder);color:#777;pointer-events:none;}
.audio-prompt-editor :deep(.pause-chip) {display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;padding:0 7px;margin:2px 3px 2px 0;border:1px solid #ffffff20;border-radius:12px;background:#242424;color:#bbb;font-size:12px;line-height:19px;user-select:none;}
.audio-prompt-editor :deep(.pause-chip button) {font-size:13px;color:#888;cursor:pointer;}
.audio-prompt-editor :deep(.pause-chip button:hover) {color:white;}
</style>
