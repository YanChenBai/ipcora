import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { IpcRequest, IpcResponse } from "ipcora";

export interface ExposeIpcoraBridgeOptions {
  /** The ipcora channel name (must match what the main process uses). */
  channel: string;
  /** Key on `window` to expose the bridge. @default "__IPCORA__" */
  apiKey?: string;
}

export interface IpcoraBridge {
  invoke(request: IpcRequest): Promise<IpcResponse>;
  subscribe(
    eventChannel: string,
    listener: (payload: unknown) => void,
  ): () => void;
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
 * exposeIpcoraBridge({ channel: "app:ipc" });
 * ```
 */
export function exposeIpcoraBridge(options: ExposeIpcoraBridgeOptions): void {
  const apiKey = options.apiKey ?? "__IPCORA__";
  const channel = options.channel;

  contextBridge.exposeInMainWorld(apiKey, {
    invoke(request: IpcRequest): Promise<IpcResponse> {
      return ipcRenderer.invoke(channel, request);
    },
    subscribe(
      eventChannel: string,
      listener: (payload: unknown) => void,
    ): () => void {
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
