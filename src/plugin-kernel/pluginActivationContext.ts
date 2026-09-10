import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginIdentity } from "./types.js";

const activation = new AsyncLocalStorage<PluginIdentity>();

export function runPluginActivation<T>(identity: PluginIdentity, operation: () => T): T {
  return activation.run(identity, operation);
}

export function currentPluginActivation(): PluginIdentity | undefined {
  return activation.getStore();
}
