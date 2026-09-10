import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VideoService } from "./service.mjs";
import { validateCommand, buildWorkflow } from "./workflow.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
const command = { model: catalog.models[0].id, prompt: "A paper boat floating on a pond.", width: 512, height: 512, frames: 22, seed: 1 };
async function fixture(t) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-test-"));
  let stopped = 0;
  const runtime = { stateRoot, alive: () => true, stop: async () => { stopped++; } };
  const service = new VideoService(runtime, catalog, () => {});
  await service.initialize(); service.online = true; service.pump = () => {};
  t.after(async () => { await service.close(); await fs.rm(stateRoot, { recursive: true, force: true }); });
  return { service, runtime, stopped: () => stopped };
}
test("invalid dimensions, frame counts, unknown fields and disguised images are rejected", () => {
  for (const change of [{ frames: 24 }, { width: 513 }, { seed: -1 }, { workflow: {} }, { firstFrame: "aGVsbG8=" }]) assert.throws(() => validateCommand({ ...command, ...change }, catalog));
  assert.equal(validateCommand(command, catalog).frames, 22);
});
test("workflow has no sound track and keeps optional first and last frames separate", () => {
  const workflow = buildWorkflow(catalog.models[0], { ...command, id: "example" }, "first.png", "last.png");
  assert.deepEqual(workflow["8"].inputs.first_frame, ["1", 0]);
  assert.equal(workflow["2"].inputs.image, "last.png");
  assert.equal(workflow["16"].inputs.audio, undefined);
});
test("same key replays one job, changed command conflicts, and replay survives restart", async t => {
  const { service, runtime } = await fixture(t);
  const first = await service.submit(command, "test-key-123");
  assert.equal((await service.submit(command, "test-key-123")).id, first.id);
  await assert.rejects(service.submit({ ...command, seed: 2 }, "test-key-123"), /不同参数/);
  const recovered = new VideoService(runtime, catalog, () => {});
  await recovered.initialize();
  const replay = await recovered.submit(command, "test-key-123");
  assert.equal(replay.id, first.id); assert.equal(replay.status, "interrupted");
});
test("queue cancellation is durable; a running task cannot be cancelled or stopped", async t => {
  const { service, runtime } = await fixture(t);
  const job = await service.submit(command, "cancel-key-123");
  await service.cancel(job.id);
  const stored = JSON.parse(await fs.readFile(path.join(runtime.stateRoot, "jobs", `${job.id}.json`), "utf8"));
  assert.equal(stored.status, "cancelled");
  service.jobs.get(job.id).status = "running";
  await assert.rejects(service.cancel(job.id), /只能取消/);
  await assert.rejects(service.stop(), /仍有生成任务/);
});
test("queue bounds reject excess jobs without creating records", async t => {
  const { service } = await fixture(t);
  for (let index = 0; index < 8; index++) await service.submit(command, `bounded-key-${index}`);
  await assert.rejects(service.submit(command, "bounded-key-extra"), /队列已满/);
  assert.equal(service.jobs.size, 8);
});
test("a lost provider result stops owned runtime and interrupts waiting jobs", async t => {
  const { service, stopped } = await fixture(t);
  const first = await service.submit(command, "failure-key-one");
  const second = await service.submit(command, "failure-key-two");
  service.generate = async () => { throw new Error("lost response"); };
  await service.runQueue();
  assert.equal(service.jobs.get(first.id).status, "failed");
  assert.equal(service.jobs.get(second.id).status, "interrupted");
  assert.equal(stopped(), 1);
});
test("only a returned, owned MP4 is marked generated and exposed by opaque ID", async t => {
  const { service, runtime } = await fixture(t);
  const job = await service.submit(command, "success-key-one");
  await fs.mkdir(path.join(runtime.stateRoot, "provider-output"), { recursive: true });
  await fs.writeFile(path.join(runtime.stateRoot, "provider-output", `${job.id}.mp4`), Buffer.from("000000186674797069736F6D00000000", "hex"));
  service.generate = async () => ({ outputs: { "17": { images: [{ type: "output", filename: `${job.id}.mp4`, subfolder: "" }] } } });
  await service.runQueue();
  const result = service.view(service.jobs.get(job.id));
  assert.equal(result.status, "succeeded"); assert.equal(result.output, undefined);
  assert.equal(result.videoUrl, `/api/video/jobs/${job.id}/video`);
  service.jobs.get(job.id).output.subfolder = "../..";
  await assert.rejects(service.outputPath(service.jobs.get(job.id)), /超出/);
});

test("image commands reject video-only fields and oversize output", () => {
  const input={model:"z-image-turbo",prompt:"paper boat",width:1024,height:1024,seed:1};
  assert.equal(validateCommand(input,catalog).frames,undefined);
  for(const change of [{frames:22},{references:[]},{width:4096},{height:1025}]) assert.throws(()=>validateCommand({...input,...change},catalog));
});
test("PNG image jobs persist in the shared queue and expose only an image result", async t => {
  const {service,runtime}=await fixture(t);
  const job=await service.submit({model:"z-image-turbo",prompt:"paper boat",width:512,height:512,seed:1},"image-success-key");
  await fs.mkdir(path.join(runtime.stateRoot,"provider-output"),{recursive:true});
  await fs.writeFile(path.join(runtime.stateRoot,"provider-output",`${job.id}.png`),Buffer.from("89504e470d0a1a0a0000000d49484452","hex"));
  service.generate=async()=>({outputs:{"10":{images:[{type:"output",filename:`${job.id}.png`,subfolder:""}]}}});
  await service.runQueue();
  const view=service.view(service.jobs.get(job.id));
  assert.equal(view.status,"succeeded"); assert.equal(view.videoUrl,undefined);
  assert.equal(view.imageUrl,`/api/video/jobs/${job.id}/image`);
  assert.equal(view.mediaKind,"image");
});
