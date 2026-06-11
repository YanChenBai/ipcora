import { createIpcora } from '@ipcora/core';
import type {
  IpcEvent,
  Ipcora,
  IpcoraOptions,
  IpcPeer,
  IpcRequest,
  IpcTransport,
} from '@ipcora/core';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

export type ElectronIpcEvent = IpcMainInvokeEvent & IpcEvent<WebContents>;

export type ElectronIpcMain = Pick<IpcMain, 'handle' | 'listenerCount' | 'removeHandler'>;

export type ElectronIpcTransport = IpcTransport<ElectronIpcEvent>;

export interface ElectronIpcoraOptions extends Omit<IpcoraOptions, 'transport'> {
  ipcMain: ElectronIpcMain;
}

export type ElectronIpcPeer = IpcPeer<WebContents> & {
  window: BrowserWindow;
};

export function createElectronTransport(ipcMain: ElectronIpcMain): ElectronIpcTransport {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, request) =>
        handler(event as ElectronIpcEvent, request as IpcRequest),
      );
    },
    listenerCount(channel) {
      return ipcMain.listenerCount(channel);
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
  };
}

export function createElectronIpcora<TContext extends object = {}, TStore extends object = {}>(
  options: ElectronIpcoraOptions,
): Ipcora<TContext, TStore> {
  const { ipcMain, ...ipcoraOptions } = options;
  return createIpcora<TContext, TStore>({
    ...ipcoraOptions,
    transport: createElectronTransport(ipcMain),
  });
}

export function createBrowserWindowPeer(window: BrowserWindow): ElectronIpcPeer {
  return {
    id: window.webContents.id,
    sender: window.webContents,
    window,
    onDispose(dispose) {
      window.once('closed', dispose);
    },
  };
}

export function bindBrowserWindow<TContext extends object, TStore extends object>(
  ipcora: Ipcora<TContext, TStore>,
  window: BrowserWindow,
  options: { context: Partial<TContext> },
): () => void {
  return ipcora.bind(createBrowserWindowPeer(window), options);
}
