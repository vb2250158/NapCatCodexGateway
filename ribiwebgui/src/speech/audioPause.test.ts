import test from "node:test";
import assert from "node:assert/strict";
import {splitAudioPrompt,encodeAudioWithPauses,synthesizeWithPauses} from "./audioPause";
test("mixed text, consecutive pauses and spoken cues keep their order",()=>{
 assert.deepEqual(splitAudioPrompt("<#1#><#2#>你好<#0.5#>我是xxx<[嗯]>"),[{kind:"pause",seconds:1},{kind:"pause",seconds:2},{kind:"text",text:"你好"},{kind:"pause",seconds:0.5},{kind:"text",text:"我是xxx"},{kind:"cue",text:"嗯"}]);
 assert.deepEqual(splitAudioPrompt("<#99#>"),[{kind:"text",text:"<#99#>"}]);
});
test("WAV includes exact silent sample counts in sequence",async()=>{
 const wav=await encodeAudioWithPauses([new Float32Array([.5]),1,2,.5,new Float32Array([-.5])],8000).arrayBuffer();const view=new DataView(wav);
 assert.equal(view.getUint32(40,true),(28000+2)*2);
 assert.equal(view.getInt16(44,true),16384);
 for(let i=1;i<=28000;i++)assert.equal(view.getInt16(44+i*2,true),0);
 assert.equal(view.getInt16(44+28001*2,true),-16384);
});
test("cue labels are spoken without markup and no-pause audio is preserved",async()=>{
 let received="";const original=new Blob(["audio"]);
 const audio=await synthesizeWithPauses("你好<[嗯]>再见",async text=>{received=text;return original;});
 assert.equal(received,"你好嗯再见");assert.equal(audio,original);
});
test("pause-only output needs no TTS and closes decoder",async()=>{
 let closed=false;const old=globalThis.AudioContext;
 globalThis.AudioContext=class{sampleRate=48000;async close(){closed=true;}} as unknown as typeof AudioContext;
 try{const audio=await synthesizeWithPauses("<#0.5#><#1#><#2#>",async()=>{throw new Error("must not call TTS");});assert.equal(audio.size,44+168000*2);assert.ok(closed);}finally{globalThis.AudioContext=old;}
});
