import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { buildWorkflow, validateCommand } from "./workflow.mjs";
import { VideoAssets } from "./assets.mjs";
import { VideoService } from "./service.mjs";
import http from "node:http";
import { streamMedia } from "./media.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
const model = catalog.models.find(item => item.mode === "reference");
const command = {model:model.id,prompt:"Animate <Picture 1> with <Video 1> and <Audio 2>.",references:[randomUUID()],width:512,height:512,frames:22,seed:1};

test("reference playback supports seeking, suffix ranges and rejects invalid ranges", async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"video-range-")), file=path.join(root,"test.mp4");
  await fs.writeFile(file,"0123456789");
  const server=http.createServer((request,response)=>{void streamMedia(request,response,file,"video/mp4").catch(()=>response.destroy());});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  for(const [range,status,body] of [["bytes=2-5",206,"2345"],["bytes=-3",206,"789"],["bytes=10-",416,""],["bytes=8-2",416,""],["bytes=-0",416,""]]) {
    const response=await fetch(url,{headers:{range}});assert.equal(response.status,status);assert.equal(await response.text(),body);
  }
});

test("mixed references preserve per-type ordinals and pair video sound with its own video", () => {
  const graph = buildWorkflow(model, {...command,id:"test",generateAudio:true,referenceVideoSound:true},undefined,undefined,[
    {kind:"audio",filename:"tone.wav"}, {kind:"image",filename:"one.png"},
    {kind:"video",filename:"silent.mp4",hasAudio:false}, {kind:"video",filename:"sound.mp4",hasAudio:true},
    {kind:"image",filename:"two.png"},
  ]);
  assert.deepEqual(graph[8].inputs["ref_images.ref_image_1"],["108",0]);
  assert.deepEqual(graph[8].inputs["ref_video_audios.ref_video_audio_1"],["107",1]);
  assert.equal(graph[8].inputs["ref_video_audios.ref_video_audio_0"],undefined);
  assert.deepEqual(graph[8].inputs["ref_audios.ref_audio_0"],["100",0]);
  assert.equal(graph[4],undefined);
  assert.equal(graph[12].inputs.steps,20);
  assert.deepEqual(graph[16].inputs.audio,["15",0]);
});
test("reference requests reject duplicate IDs, paths, missing assets and mixed frame mode", () => {
  for(const change of [{references:[]},{references:["../private.wav"]},{references:[command.references[0],command.references[0]]},{generateAudio:"true"},{firstFrame:"abc"},{model:catalog.models[0].id}]) assert.throws(()=>validateCommand({...command,...change},catalog));
  assert.equal(validateCommand(command,catalog).generateAudio,false);
});
test("uninstalled optional reference nodes do not block a ready frame model", async t => {
  const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),"video-optional-"));
  t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
  const service=new VideoService({stateRoot,alive:()=>true,start:async()=>"http://example.invalid",stop:async()=>{}},catalog,()=>{});
  const info=Object.fromEntries(Object.values(buildWorkflow(catalog.models[0],{...command,id:"check"})).map(node=>[node.class_type,{input:{required:{}}}]));
  for(const [node,field,file] of [["UNETLoader","unet_name","diffusion"],["CLIPLoader","clip_name","textEncoder"],["VAELoader","vae_name","vae"],["LoraLoaderModelOnly","lora_name","lora"]]) info[node].input.required[field]=[[catalog.models[0].files[file]]];
  service.request=async route=>route==="/object_info"?info:{};
  assert.deepEqual((await service.start()).availableModels,[catalog.models[0].id]);
});
test("asset IDs become readable only after successful inspection; oversized and readonly uploads are rejected", async t => {
  const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),"video-assets-"));
  t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
  let valid=true;
  const runtime={stateRoot,inspectAsset:async()=>{if(!valid) throw new Error("decode failed");return {width:512,height:512};}};
  const assets=new VideoAssets(runtime);
  const body=()=>{const stream=Readable.from([Buffer.from("test")]);stream.headers={};return stream;};
  const record=await assets.upload(body(),"image");
  assert.equal((await assets.read(record.id)).width,512);
  await assert.rejects(assets.read("../../anything"));
  valid=false; await assert.rejects(assets.upload(body(),"video"),/无法解码/);
  assert.equal((await fs.readdir(assets.root)).filter(name=>name.endsWith(".json")).length,1);
  const large=body();large.headers["content-length"]=100*1024**2;
  await assert.rejects(assets.upload(large,"video"),/过大/);
  runtime.readOnly=true;await assert.rejects(assets.upload(body(),"audio"),/只读/);
});
