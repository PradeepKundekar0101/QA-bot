import "../env.js";
import { mongoStore } from "./mongo.js";
import { memoryStore } from "./memory.js";
import type { Store } from "./types.js";

let shared: Promise<Store> | undefined;

/**
 * The process-wide store, memoised so the API and the CLI share one connection pool.
 * QA_PILOT_STORE=memory keeps everything in the process instead, for a local demo or an
 * end-to-end check without a database; accounts, runs and payments are gone on restart.
 */
export function defaultStore(): Promise<Store> {
  shared ??= process.env.QA_PILOT_STORE === "memory" ? Promise.resolve(memoryStore()) : mongoStore();
  return shared;
}

export * from "./types.js";
export { memoryStore } from "./memory.js";
export { mongoStore } from "./mongo.js";
