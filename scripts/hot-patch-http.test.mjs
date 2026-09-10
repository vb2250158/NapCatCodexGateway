import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { compileHotPatchModule } from "./lib/hot-patch-compiler.mjs";
import { HotPatchModule } from "../src/plugin-kernel/hotPatchModule.ts";

test("HTTP stays listening while source changes, old requests drain and state survives rollback", async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const source = `declare const pause: (slow: boolean) => Promise<void>;
    let completed = 0;
    function label() { return 'before'; }
    export async function handle(slow: boolean) {
      await pause(slow); completed++; return { label: label(), completed };
    }`;
  const module = new HotPatchModule("http-fixture", compileHotPatchModule(source), {
    pause: slow => slow ? delayed : Promise.resolve()
  });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.end("healthy"); return; }
    const result = module.exports.handle(request.url === "/slow");
    if (request.url === "/slow") started();
    result.then(value => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    }).catch(error => { response.statusCode = 500; response.end(error.message); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const oldRequest = fetch(`${base}/slow`).then(response => response.json());
    await entered;
    const beforeAddress = server.address();
    module.apply(compileHotPatchModule(source.replace("'before'", "'after'")), 0, { responseVersion: 2 });
    const reads = await Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/fast`).then(response => response.json())));
    assert.ok(reads.every(value => value.label === "after"));
    assert.equal(new Set(reads.map(value => value.completed)).size, 12);
    assert.equal(await fetch(`${base}/health`).then(response => response.text()), "healthy");
    assert.deepEqual(server.address(), beforeAddress);
    release();
    assert.deepEqual(await oldRequest, { label: "before", completed: 13 });
    module.rollback(1);
    assert.deepEqual(await fetch(`${base}/fast`).then(response => response.json()), { label: "before", completed: 14 });
    assert.ok(module.snapshot().retained.every(revision => revision.leases === 0));
  } finally {
    release();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    module.runtime.close();
  }
});
