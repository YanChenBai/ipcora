import { createIpcora } from "ipcora";
import type { IpcEvent, Ipcora, IpcAdapter, IpcoraOptions, IpcPeer, IpcRequest } from "ipcora";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

export type ElectronIpcEvent = IpcMainInvokeEvent & IpcEvent<WebContents>;

export type ElectronIpcMain = Pick<IpcMain, "handle" | "listenerCount" | "removeHandler">;

export type ElectronIpcAdapter = IpcAdapter<ElectronIpcEvent>;

export interface ElectronIpcoraOptions extends Omit<IpcoraOptions, "adapter"> {
  ipcMain: ElectronIpcMain;
}

export type ElectronIpcPeer = IpcPeer<WebContents> & {
  window: BrowserWindow;
};

export function createElectronAdapter(ipcMain: ElectronIpcMain): ElectronIpcAdapter {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, request) =>
        handler(event as ElectronIpcEvent, request as IpcRequest),
      );
    },
    emit(channel, sender, payload) {
      sender.send(channel, payload);
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
    adapter: createElectronAdapter(ipcMain),
  });
}

export function createBrowserWindowPeer(window: BrowserWindow): ElectronIpcPeer {
  return {
    id: window.webContents.id,
    sender: window.webContents,
    window,
    onDispose(dispose) {
      window.once("closed", dispose);
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
