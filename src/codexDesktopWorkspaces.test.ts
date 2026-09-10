import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listCodexDesktopWorkspaces } from "./codexDesktopBridge.js";

test("workspace discovery needs no task bodies or sidebar index and preserves active scope", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-workspace-query-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE threads (id TEXT, cwd TEXT, archived INTEGER,
    updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER)`);
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, 1, 1000, 1, 1000)");
  insert.run("first", " C:/Work/One ", 0);
  insert.run("duplicate", "C:/Work/One", 0);
  insert.run("second", "C:/Work/Two", 0);
  insert.run("archived", "C:/Work/Archived", 1);
  insert.run("", "C:/Work/Invalid", 0);
  insert.run("blank", "   ", 0);
  database.close();
  assert.deepEqual(new Set(listCodexDesktopWorkspaces(databasePath)), new Set(["C:/Work/One", "C:/Work/Two"]));
  assert.deepEqual(listCodexDesktopWorkspaces(null), []);
});
