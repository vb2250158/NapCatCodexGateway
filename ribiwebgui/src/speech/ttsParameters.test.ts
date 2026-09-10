import test from "node:test";
import assert from "node:assert/strict";
import type {SpeechModel} from "@shared/speechControlContract";
import {ttsSystemVoices,ttsCapabilities,normalizeTtsParameters,ttsCommandSettings} from "./ttsParameters";
function model(features:string[],id="test"):SpeechModel {return {id,features,name:id,model:id,provider:"local",capability:"tts",family:"test",installed:true,enabled:true,loaded:false,available:true,isDefault:false,languages:["zh","en"],request:{properties:{voice:{},speed:{minimum:.25,maximum:4,default:1},instructions:{maxLength:2000},language:{},emotion_vector:{}}}};}
test("shared schema does not enable unsupported emotion/instructions",()=>{const c=ttsCapabilities(model(["fixed_speakers"]));assert.ok(c.fixedVoice);assert.equal(c.emotion,false);assert.equal(c.instructions,false);assert.equal(c.language,false);});
test("Index emotion and instruction models expose distinct controls",()=>{assert.ok(ttsCapabilities(model(["emotion_control","voice_clone"])).emotion);const qwen=ttsCapabilities(model(["instructions","multilingual","voice_clone"]));assert.ok(qwen.instructions);assert.ok(qwen.language);assert.equal(qwen.emotion,false);assert.equal(ttsCapabilities(model(["voice_clone","zero_shot"])).instructions,false);});
test("parameters clamp to schema and unsupported values cannot leak",()=>{const m=model(["fixed_speakers"]);assert.deepEqual(normalizeTtsParameters(m,{voice:"speaker:2",speed:10,language:"en",emotion:"愤怒",instructions:"angry"}),{voice:"speaker:2",speed:4});const body=ttsCommandSettings(m,{language:"en",emotion:"愤怒",instructions:"angry"});assert.equal(body.instructions,null);assert.equal(body.language,null);assert.equal(body.voice,"default");});
test("emotion instructions reach existing synthesis contract and reset restores defaults",()=>{const m=model(["emotion_control"]);assert.equal(ttsCommandSettings(m,{emotion:"高兴",instructions:"轻声"}).instructions,"整段语音以高兴为整体情绪基调。轻声");assert.equal(normalizeTtsParameters(m).emotion,"无");assert.equal(normalizeTtsParameters(m).speed,1);assert.equal(ttsCommandSettings(model(["multilingual"]),{language:"xx"}).language,null);});

test("local worker compatibility hides fields not consumed and exposes GPT language",()=>{
 const q=ttsCapabilities(model(["instructions","multilingual"],"local-tts/qwen3-tts-0.6b-base"));assert.equal(q.instructions,false);assert.equal(q.speed,undefined);assert.equal(q.language,true);
 const index=ttsCapabilities(model(["emotion_control"],"local-tts/indextts2"));assert.equal(index.speed,undefined);assert.equal(index.emotion,true);
 const g=ttsCapabilities(model(["voice_clone"],"local-tts/gpt-sovits"));assert.equal(g.language,true);assert.deepEqual(g.speed,{min:.5,max:2,default:1});
 const cosy=ttsCapabilities(model(["multilingual","instructions"],"local-tts/cosyvoice3-0.5b"));assert.equal(cosy.language,false);assert.equal(cosy.instructions,true);
});

test("system speaker catalog preserves names and forwards selected speaker id",()=>{
 const m=model(["fixed_speakers"]);
 m.request={properties:{voice:{oneOf:[{const:"speaker:155",title:"中日女性音色 1"},{const:2,title:"invalid"}]}}};
 assert.deepEqual(ttsSystemVoices(m),[{id:"speaker:155",name:"中日女性音色 1"}]);
 assert.equal(ttsCommandSettings(m,{voice:"speaker:155"}).voice,"speaker:155");
 assert.deepEqual(ttsSystemVoices(model([])),[]);
});
