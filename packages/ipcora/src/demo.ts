/**
 * Ipcora demo — full-featured showcase with a simple in-memory adapter.
 *
 * Implementation lives in `./demo/`.  This file re-exports the public API.
 *
 * Run directly:
 *   npx tsx src/demo.ts
 */

export { runDemo, createAppIpcora, createMemoryAdapter } from './demo/index';
export type { AppIpcora, AppState, AppContext } from './demo/index';
