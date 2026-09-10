import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {selectWorkflow} from './workflowRouting.mjs';
import {buildWorkflow} from './workflow.mjs';
const catalog=JSON.parse(await fs.readFile(new URL('./catalog.json',import.meta.url),'utf8'));
const model=catalog.models[0];
const input={quickGeneration:true,width:768,height:768,frames:107,generateAudio:false};
const available=(...ids)=>ids.map(workflowId=>({model:model.id,workflowId,generateAudio:false}));
test('routes native silent output, low resolution, and sound to compatible candidates',()=>{
  assert.equal(selectWorkflow(model,input),'fast-768');
  assert.equal(selectWorkflow(model,{...input,width:512}),'fast');
  assert.equal(selectWorkflow(model,{...input,generateAudio:true}),'fast');
  assert.equal(selectWorkflow(model,{...input,quickGeneration:false}),'standard');
  assert.equal(selectWorkflow(catalog.models[1],input),'fast');
});
test('unavailable preferred candidate falls back within compatible fast candidates only',()=>{
  assert.equal(selectWorkflow(model,input,available('fast')),'fast');
  assert.throws(()=>selectWorkflow(model,input,available('standard')),/没有已就绪/);
  assert.throws(()=>selectWorkflow(model,{...input,width:512},available('fast-768')),/没有已就绪/);
});
test('persisted route controls the graph even if automatic priorities differ',()=>{
  const graph=buildWorkflow(model,{...input,workflowId:'fast',id:'check',prompt:'ball',seed:1});
  assert.equal(graph[12].inputs.steps,8);
  assert.equal(graph[4].inputs.lora_name,model.files.lora);
  const fast=buildWorkflow(model,{...input,id:'check',prompt:'ball',seed:1});
  assert.equal(fast[12].inputs.steps,4);
  assert.equal(fast[4].inputs.lora_name,model.files.lora4);
});
