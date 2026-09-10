import assert from "node:assert/strict";
import test from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { useVideoCanvas } from "./useVideoCanvas";

async function fixture() {
  let canvas!: ReturnType<typeof useVideoCanvas>;
  await renderToString(createSSRApp({ setup() { canvas = useVideoCanvas(); return () => null; } }));
  let capture: number | undefined;
  canvas.viewport.value = {
    clientWidth: 1200, clientHeight: 900,
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    setPointerCapture(id: number) { capture = id; },
    hasPointerCapture(id: number) { return capture === id; },
    releasePointerCapture() { capture = undefined; },
  } as unknown as HTMLElement;
  return canvas;
}
function pointer(x: number, y: number, id = 1) {
  return { clientX: x, clientY: y, pointerId: id, button: 0, preventDefault() {} } as PointerEvent;
}
test("zoom preserves the world point under its anchor and clamps the supported range", async () => {
  const canvas = await fixture();
  const anchor = { x: 213, y: 117 }, before = canvas.world(anchor);
  canvas.zoom(1.7, anchor);
  assert.ok(Math.abs(canvas.world(anchor).x - before.x) < 1e-9);
  assert.ok(Math.abs(canvas.world(anchor).y - before.y) < 1e-9);
  canvas.zoom(100); assert.equal(canvas.scale.value, 2);
  canvas.zoom(0); assert.equal(canvas.scale.value, 0.25);
});
test("card dragging converts screen distance by zoom and ignores unrelated pointers", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.scale.value = 0.5;
  canvas.begin(pointer(10, 20), "a");
  canvas.move(pointer(110, 70, 2)); assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  canvas.move(pointer(110, 70)); assert.deepEqual(canvas.positions.value.a, { x: 200, y: 100 });
  canvas.end(pointer(110, 70)); canvas.move(pointer(210, 100));
  assert.deepEqual(canvas.positions.value.a, { x: 200, y: 100 }); assert.equal(canvas.dragging.value, false);
});
test("hand mode pans without moving cards; fit includes cards at negative coordinates", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.add("b");
  canvas.handMode.value = true; canvas.begin(pointer(0, 0), "a"); canvas.move(pointer(100, 50)); canvas.end(pointer(100, 50));
  assert.deepEqual(canvas.positions.value.a, { x: 0, y: 0 });
  canvas.positions.value.a = { x: -900, y: -100 };
  canvas.fit();
  for (const position of Object.values(canvas.positions.value)) {
    const point = canvas.world({ x: 0, y: 0 });
    assert.ok(position.x >= point.x && position.y >= point.y);
    const right = canvas.world({ x: 1200, y: 900 });
    assert.ok(position.x + 640 <= right.x && position.y + 620 <= right.y);
  }
});

test("left background drag selects cards without panning, then selected cards move together", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.add("b");
  const down = { ...pointer(0, 0), target: { closest() { return null; } } } as unknown as PointerEvent;
  const before = canvas.world({x:0,y:0});
  canvas.backgroundDown(down); canvas.move(pointer(1300,300)); canvas.end(pointer(1300,300));
  assert.deepEqual(canvas.selectedIds.value, ["a","b"]);
  assert.deepEqual(canvas.world({x:0,y:0}), before);
  canvas.begin(pointer(200,100),"a"); canvas.move(pointer(250,125)); canvas.end(pointer(250,125));
  assert.deepEqual(canvas.positions.value.a,{x:50,y:25});
  assert.deepEqual(canvas.positions.value.b,{x:770,y:25});
});
test("middle button pans without selecting or moving cards", async () => {
  const canvas = await fixture(); canvas.add("a"); canvas.selectedIds.value=["a"];
  const down = { ...pointer(0,0), button:1, target:{closest(){return null;}} } as unknown as PointerEvent;
  canvas.backgroundDown(down); canvas.move(pointer(80,40)); canvas.end(pointer(80,40));
  assert.deepEqual(canvas.positions.value.a,{x:0,y:0});
  assert.deepEqual(canvas.world({x:0,y:0}),{x:-80,y:-40});
  assert.deepEqual(canvas.selectedIds.value,["a"]);
});
