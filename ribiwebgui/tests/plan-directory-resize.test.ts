import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { directoryKeyboardWidth, directoryMaximum, directoryWidthFor, PLAN_DIRECTORY_SIZE } from "../src/planDirectoryResize";

test("directory collapses only below the drag threshold and reopens at a usable width", () => {
  assert.equal(directoryWidthFor(159, 600), 0);
  assert.equal(directoryWidthFor(160, 600), 260);
  assert.equal(directoryWidthFor(259, 600), 260);
  assert.equal(directoryWidthFor(360, 600), 360);
  assert.equal(directoryWidthFor(-500, 600), 0);
});

test("directory resize preserves content space and clamps extreme drags", () => {
  assert.equal(directoryMaximum(1000), 600);
  assert.equal(directoryMaximum(800), 479);
  assert.equal(directoryMaximum(400), 260);
  assert.equal(directoryWidthFor(5000, 479), 479);
  assert.equal(directoryWidthFor(360, directoryMaximum(600)), 279);
  assert.equal(directoryWidthFor(0, directoryMaximum(600)), 0);
});

test("keyboard can resize, collapse and restore the directory", () => {
  assert.equal(directoryKeyboardWidth("ArrowLeft", 360, 600, 420), 340);
  assert.equal(directoryKeyboardWidth("ArrowLeft", 260, 600, 420), 0);
  assert.equal(directoryKeyboardWidth("ArrowRight", 0, 600, 420), 260);
  assert.equal(directoryKeyboardWidth("ArrowRight", 600, 600, 420), 600);
  assert.equal(directoryKeyboardWidth("Home", 360, 600, 420), 0);
  assert.equal(directoryKeyboardWidth("End", 360, 600, 420), 600);
  assert.equal(directoryKeyboardWidth("Enter", 360, 600, 420), 0);
  assert.equal(directoryKeyboardWidth("Enter", 0, 400, 420), 400);
  assert.equal(directoryKeyboardWidth("Tab", 360, 600, 420), null);
});

test("drag can cross the collapse threshold and return in the same gesture", () => {
  const start = PLAN_DIRECTORY_SIZE.initial;
  assert.deepEqual([0, -100, -201, -250, -199, 50].map(delta => directoryWidthFor(start + delta, 600)), [360, 260, 0, 0, 260, 410]);
  assert.deepEqual([0, 50, 159, 160, 350].map(delta => directoryWidthFor(delta, 600)), [0, 0, 0, 260, 350]);
});

test("directory uses a captured accessible separator and a single-row header without a gutter", () => {
  const page = fs.readFileSync("ribiwebgui/src/pages/RoleKnowledgePage.vue", "utf8");
  const css = fs.readFileSync("ribiwebgui/src/styles.css", "utf8");
  const resize = fs.readFileSync("ribiwebgui/src/planDirectoryResize.ts", "utf8");
  assert.doesNotMatch(page, /点击计划快速跳转/);
  assert.match(page, /role="separator"/);
  assert.match(page, /@pointercancel="cancelDirectoryResize"/);
  assert.match(page, /@lostpointercapture="finishDirectoryResize"/);
  assert.match(page, /v-show="!directoryCollapsed"/);
  assert.match(css, /grid-template-columns: var\(--plan-directory-width, 360px\) 1px minmax\(0, 1fr\);\s+gap: 0;/);
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(resize, /setPointerCapture\(event.pointerId\)/);
  assert.match(resize, /onDeactivated\(deactivate\)/);
  assert.match(resize, /onBeforeUnmount\(deactivate\)/);
});
