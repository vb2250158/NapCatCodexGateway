import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildWorkflow, validateCommand, resolveWorkflow } from "./workflow.mjs";
import { VideoService } from "./service.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
const command = {id:"test",prompt:"A paper boat",width:512,height:512,frames:22,seed:1};

test("standard and fast routes preserve conditioning and use variant-specific LoRAs", () => {
  for (const model of catalog.models.filter(row=>row.workflows)) {
    for (const quickGeneration of [false,true]) {
      const job = {...command,model:model.id,quickGeneration};
      const graph = buildWorkflow(model,job,"first.png","last.png");
      assert.equal(graph[12].inputs.steps,quickGeneration ? model.workflows.fast.steps : 20);
      assert.equal(graph[4]?.inputs.lora_name,quickGeneration ? model.files.lora : undefined);
      assert.deepEqual(graph[10].inputs.model,graph[12].inputs.model);
      assert.deepEqual(graph[8].inputs.first_frame,["1",0]);
      assert.deepEqual(graph[8].inputs.last_frame,["2",0]);
      assert.equal(graph[16].inputs.audio,undefined);
    }
  }
});
test("audio generation is independent of reference mode and quick generation", () => {
  for (const model of catalog.models.filter(row=>row.workflows)) {
    for (const quickGeneration of [false,true]) {
      const job={...command,model:model.id,quickGeneration,generateAudio:true,...(model.mode==='reference'?{references:['11111111-1111-1111-1111-111111111111']}:{})};
      const checked=validateCommand(jobWithoutId(job),catalog);
      const graph=buildWorkflow(model,{...checked,id:'test'});
      assert.deepEqual(graph[16].inputs.audio,["15",0]);
      assert.equal(graph[7].inputs.vae_name,model.files.audioVae);
    }
  }
});
function jobWithoutId({id,...job}) { return job; }
test("invalid fast options are rejected and omitted options retain legacy sampling", () => {
  for (const quickGeneration of ["true",1,null]) assert.throws(()=>validateCommand({...jobWithoutId(command),model:catalog.models[0].id,quickGeneration},catalog));
  assert.equal(resolveWorkflow(catalog.models[0],{}).steps,8);
  assert.equal(resolveWorkflow(catalog.models[1],{}).steps,20);
  assert.equal(resolveWorkflow(catalog.models[0],{quickGeneration:false}).files.lora,undefined);
});
test("missing optional LoRA leaves standard available and rejects fast before queueing", async () => {
  const model = catalog.models[0];
  const graph = buildWorkflow(model,{...command,quickGeneration:false});
  const info=Object.fromEntries(Object.values(graph).map(node=>[node.class_type,{input:{required:{}}}]));
  for(const [node,key,file] of [["UNETLoader","unet_name",model.files.diffusion],["CLIPLoader","clip_name",model.files.textEncoder],["VAELoader","vae_name",model.files.vae]]) info[node].input.required[key]=[[file]];
  const service=new VideoService({alive:()=>true,start:async()=>"http://example.invalid",stop:async()=>{}},{...catalog,models:[model]},()=>{});
  service.request=async route=>route==='/object_info'?info:{};
  const snapshot=await service.start();
  assert.deepEqual(snapshot.availableWorkflows,[{model:model.id,workflowId:'standard',generateAudio:false}]);
  await assert.rejects(service.submit({...jobWithoutId(command),model:model.id,quickGeneration:true},'missing-fast-001'),/工作流/);
  assert.equal(service.jobs.size,0);
});
