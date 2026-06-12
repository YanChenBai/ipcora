import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { IpcRequest, IpcResponse } from 'ipcora';

import { ELECTRON_IPCORA_CHANNEL } from './constants';

export interface IpcoraBridge {
  invoke(request: IpcRequest): Promise<IpcResponse>;
  subscribe(eventChannel: string, listener: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    __IPCORA__?: IpcoraBridge;
  }
}

/**
 * Expose a typed IPC bridge in the renderer's `window` scope via
 * `contextBridge.exposeInMainWorld`.  Call this once in your preload script.
 *
 * @example
 * ```ts
 * // preload.ts
 * import { exposeIpcoraBridge } from "@ipcora/electron/preload";
 * exposeIpcoraBridge();
 * ```
 */
export function exposeIpcoraBridge(): void {
  contextBridge.exposeInMainWorld('__IPCORA__', {
    invoke(request: IpcRequest): Promise<IpcResponse> {
      return ipcRenderer.invoke(ELECTRON_IPCORA_CHANNEL, request);
    },
    subscribe(eventChannel: string, listener: (payload: unknown) => void): () => void {
      const handler = (_event: IpcRendererEvent, payload: unknown) => {
        listener(payload);
      };
      ipcRenderer.on(eventChannel, handler);
      return () => {
        ipcRenderer.removeListener(eventChannel, handler);
      };
    },
  } satisfies IpcoraBridge);
}
