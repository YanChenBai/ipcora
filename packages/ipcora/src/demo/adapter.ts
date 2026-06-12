/**
 * Simple in-memory adapter for Ipcora demos and tests.
 *
 * Stores handlers in a Map and exposes `invoke()` for direct calling —
 * no real IPC needed.
 */

import type {
  IpcAdapter,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  MaybePromise,
} from '../index'

export interface MemoryAdapter {
  adapter: IpcAdapter
  /** Directly invoke a handler (simulates a peer calling the router). */
  invoke(channel: string, senderId: number, request: IpcRequest): Promise<IpcResponse>
}

export function createMemoryAdapter(): MemoryAdapter {
  const handlers = new Map<
    string,
    (event: IpcEvent, request: IpcRequest) => MaybePromise<IpcResponse>
  >()

  const adapter: IpcAdapter = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    emit(channel, sender, payload) {
      // In a real adapter this sends data over the wire.
      // The demo just logs; real adapters push to connected clients.
      console.log(
        `  [adapter.emit] channel="${channel}" sender=${sender.id} payload=`,
        payload,
      )
    },
    listenerCount(channel) {
      return handlers.has(channel) ? 1 : 0
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
  }

  const invoke = async (
    channel: string,
    senderId: number,
    request: IpcRequest,
  ): Promise<IpcResponse> => {
    const handler = handlers.get(channel)
    if (!handler) {
      return {
        error: {
          name: 'ADAPTER_ERROR',
          message: `No handler registered for channel "${channel}"`,
        },
      }
    }
    return handler({ sender: { id: senderId } }, request)
  }

  return { adapter, invoke }
}
