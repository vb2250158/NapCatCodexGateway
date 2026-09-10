import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

type CompileOptions = Readonly<{ sourcePath: string; sourceContent?: string; outputDirectory: string; resourceData?: unknown }>;
type CompileResult = Readonly<{ changed: boolean; sha256: string; outputPath?: string; sourceHash?: string; symbols?: readonly string[] }>;
export type SourcePatchDependencyGraph = Readonly<{ modules: readonly Readonly<{ source: string; files: Readonly<Record<string, string | null>> }>[] }>;
type InspectOptions = Readonly<{ action: "inspect-dependencies"; root: string; sources: readonly string[] }>;

export class SourcePatchCompiler {
  private queue: Promise<void> = Promise.resolve();
  private worker?: Worker;
  private closed = false;
  private pending = 0;

  async build(options: CompileOptions): Promise<CompileResult> {
    return this.enqueue<CompileResult>(options);
  }

  async inspect(root: string, sources: readonly string[]): Promise<SourcePatchDependencyGraph> {
    return this.enqueue<SourcePatchDependencyGraph>({ action: "inspect-dependencies", root, sources });
  }

  private async enqueue<Result>(options: CompileOptions | InspectOptions): Promise<Result> {
    if (this.closed) throw new Error("Source patch compiler is closed.");
    if (this.pending >= 128) throw new Error("Source patch compiler queue is full.");
    this.pending++;
    const next = this.queue.then(() => {
      if (this.closed) throw new Error("Source patch compiler is closed.");
      return this.run<Result>(options);
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next.finally(() => { this.pending--; });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.worker) await this.worker.terminate();
    await this.queue;
  }

  private run<Result>(options: CompileOptions | InspectOptions): Promise<Result> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(fileURLToPath(new URL("../../scripts/compile-hot-patch-worker.mjs", import.meta.url)), { execArgv: [] });
      this.worker = worker;
      let settled = false;
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void worker.terminate().then(() => {
          if (this.worker === worker) this.worker = undefined;
          if (error) reject(error);
          else resolve(result!);
        }, reject);
      };
      const timeout = setTimeout(() => finish(new Error("Source patch compilation timed out after 30 seconds.")), 30_000);
      worker.once("message", message => {
        if (message?.ok) finish(undefined, message.result);
        else {
          const error = new Error(message?.error?.message ?? "Source patch compilation failed.");
          error.name = message?.error?.name ?? "SourcePatchCompilationError";
          error.stack = message?.error?.stack ?? error.stack;
          finish(error);
        }
      });
      worker.once("error", error => finish(error));
      worker.once("exit", code => finish(new Error(`Source patch compiler exited before returning a result (${code}).`)));
      try { worker.postMessage(options); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
