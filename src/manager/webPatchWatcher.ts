import fs from "node:fs";
import path from "node:path";
import type { WebPatchService } from "./webPatchService.js";

export class WebPatchWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private running = false;
  private dirty = false;
  private stopped = false;

  constructor(private readonly root: string, private readonly service: WebPatchService, private readonly onError: (error: unknown) => void) {
    this.refresh();
    this.schedule();
  }

  private refresh(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const directory of [this.root, path.join(this.root, "dist"), path.join(this.root, "dist/web-patches")]) {
      try {
        const watcher = fs.watch(directory, (_event, name) => {
          if (!name || ["dist", "web-patches", "latest.json"].includes(String(name))) this.schedule();
        });
        watcher.on("error", error => { this.onError(error); this.schedule(); });
        this.watchers.push(watcher);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error); }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, 200);
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    this.dirty = false;
    try { this.refresh(); await this.service.automatic(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error); }
    finally { this.running = false; if (this.dirty) this.schedule(); }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
