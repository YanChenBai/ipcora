import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';
import { createPikaEvents } from 'pika-events';

import { TYPE_IPC_EMITTER_NAME, TYPE_IPC_EXPOSE_NAME, TYPE_IPC_HANDLER_NAME } from './constants';
import type {
  HandlerCallbackEvent,
  Infer,
  SenderCallbackEvent,
  WebContentsSendData,
} from './types';

export function formatEventName(name: string, method: string) {
  return `${name}:${method}`;
}

export function exposeTypeIpc() {
  let isStartListening = false;

  // Global event emitter
  const emitter = createPikaEvents<{
    [channel: string]: (data: unknown) => void;
  }>();

  function startListening() {
    if (isStartListening) return;

    isStartListening = true;

    ipcRenderer.on(TYPE_IPC_EMITTER_NAME, (_, { name, method, data }: WebContentsSendData) => {
      // Remove name prefix `on`
      const eventName = formatEventName(name, method);
      emitter.emit(eventName, data);
    });
  }

  contextBridge.exposeInMainWorld(TYPE_IPC_EXPOSE_NAME, {
    invoke(data: HandlerCallbackEvent) {
      return ipcRenderer.invoke(TYPE_IPC_HANDLER_NAME, data);
    },

    /**
     * @returns unsubscribe function
     */
    message({ name, method, callback }: SenderCallbackEvent) {
      startListening();

      if (method.startsWith('once')) {
        return emitter.once(
          // Remove name prefix `once`
          formatEventName(name, method.substring(4)),
          callback,
        );
      }

      if (method.startsWith('on')) {
        return emitter.on(
          // Remove name prefix `on`
          formatEventName(name, method.substring(2)),
          callback,
        );
      }

      throw new Error(`Invalid method: ${method}`);
    },
  });
}

export type { HandlerCallbackEvent, Infer, IpcRendererEvent, SenderCallbackEvent };
