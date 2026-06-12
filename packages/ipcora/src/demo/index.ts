/**
 * Demo module — full-featured Ipcora showcase with a simple in-memory adapter.
 *
 * Usage:
 *   import { runDemo, createAppIpcora, createMemoryAdapter } from 'ipcora/demo'
 *
 * Or run directly:
 *   npx tsx src/demo/index.ts
 */

export { runDemo } from './runner'
export { createAppIpcora, createMemoryAdapter } from './ipcora'
export type { AppIpcora, AppState, AppContext } from './ipcora'
