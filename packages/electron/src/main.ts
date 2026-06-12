import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { createIpcora } from 'ipcora';
import type {
  AnyIpcora,
  EventEmitter,
  EventNames,
  EventPayloadByName,
  ExtractEvents,
  IpcEvent,
  Ipcora,
  IpcAdapter,
  IpcoraOptions,
  IpcPeer,
  IpcRequest,
} from 'ipcora';

import { ELECTRON_IPCORA_CHANNEL } from './constants';

export { ELECTRON_IPCORA_CHANNEL } from './constants';

export type ElectronIpcEvent = IpcMainInvokeEvent & IpcEvent<WebContents>;

export type ElectronIpcMain = Pick<IpcMain, 'handle' | 'listenerCount' | 'removeHandler'>;

export type ElectronIpcAdapter = IpcAdapter<ElectronIpcEvent>;

export type ElectronIpcoraOptions = Omit<IpcoraOptions, 'adapter' | 'channel'>;

export type ElectronIpcPeer = IpcPeer<WebContents> & {
  window: BrowserWindow;
};

export type BindBrowserWindowOptions<TContext extends object> = {
  context?: Partial<TContext>;
};

export interface BoundBrowserWindow<TRoutes extends object = {}> {
  id: number;
  window: BrowserWindow;
  unbind: () => void;
  emit: <const TName extends EventNames<ExtractEvents<TRoutes>> & string>(
    name: TName,
    payload: EventPayloadByName<ExtractEvents<TRoutes>, TName>,
  ) => Promise<void>;
  $emit: EventEmitter<ExtractEvents<TRoutes>>;
}

export type ElectronIpcora<TContext extends object = {}, TStore extends object = {}> = Ipcora<
  TContext,
  TStore
> & {
  bind(window: BrowserWindow, options?: BindBrowserWindowOptions<TContext>): BoundBrowserWindow;
  bind(peer: IpcPeer, options?: BindBrowserWindowOptions<TContext>): () => void;
};

export function createElectronAdapter(ipcMain: ElectronIpcMain): ElectronIpcAdapter {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, request) => {
        const windowId = BrowserWindow?.fromWebContents?.(event.sender)?.id ?? event.sender.id;
        const sender = Object.create(event.sender) as WebContents;
        Object.defineProperty(sender, 'id', { value: windowId });

        return handler({ ...event, sender } as ElectronIpcEvent, request as IpcRequest);
      });
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
  options: ElectronIpcoraOptions = {},
): ElectronIpcora<TContext, TStore> {
  const ipcora = createIpcora<TContext, TStore>({
    ...options,
    channel: ELECTRON_IPCORA_CHANNEL,
    adapter: createElectronAdapter(ipcMain),
  }) as ElectronIpcora<TContext, TStore>;

  return attachBrowserWindowBinder(ipcora);
}

export function createBrowserWindowPeer(window: BrowserWindow): ElectronIpcPeer {
  return {
    id: window.id,
    sender: window.webContents,
    window,
    onDispose(dispose) {
      window.once('closed', dispose);
    },
  };
}

export function bindBrowserWindow<
  TContext extends object,
  TStore extends object,
  TRoutes extends object,
>(
  ipcora: Ipcora<TContext, TStore, any, TRoutes, any, any>,
  window: BrowserWindow,
  options: BindBrowserWindowOptions<TContext> = {},
): BoundBrowserWindow<TRoutes> {
  const peer = createBrowserWindowPeer(window);
  const unbind = ipcora.bind(peer, { context: options.context ?? {} });

  return {
    id: peer.id,
    window,
    unbind,
    emit(name, payload) {
      return ipcora.emit(name as never, payload as never, { peers: [peer.id] });
    },
    $emit: createBoundEventEmitter(ipcora, peer.id) as EventEmitter<any>,
  };
}

function attachBrowserWindowBinder<TContext extends object, TStore extends object>(
  ipcora: ElectronIpcora<TContext, TStore>,
): ElectronIpcora<TContext, TStore> {
  const bindPeer = ipcora.bind.bind(ipcora);

  Object.defineProperty(ipcora, 'bind', {
    configurable: true,
    value(target: BrowserWindow | IpcPeer, options: BindBrowserWindowOptions<TContext> = {}) {
      if (isBrowserWindow(target)) {
        return bindBrowserWindow(ipcora, target, options);
      }

      return bindPeer(target, options);
    },
  });

  return ipcora;
}

function isBrowserWindow(value: BrowserWindow | IpcPeer): value is BrowserWindow {
  return typeof (value as BrowserWindow).webContents?.send === 'function';
}

function createBoundEventEmitter(ipcora: AnyIpcora, peerId: number): EventEmitter<any> {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toStringTag) return 'IpcoraBoundEventEmitter';
      if (typeof property !== 'string') return undefined;

      return (payload: unknown) => ipcora.emit(property, payload, { peers: [peerId] });
    },
  }) as EventEmitter<any>;
}
