export {
  createElectronAdapter,
  createElectronIpcora,
  createBrowserWindowPeer,
  bindBrowserWindow,
  ELECTRON_IPCORA_CHANNEL,
} from './main';
export type {
  ElectronIpcEvent,
  ElectronIpcMain,
  ElectronIpcAdapter,
  ElectronIpcora,
  ElectronIpcoraOptions,
  ElectronIpcPeer,
  BindBrowserWindowOptions,
  BoundBrowserWindow,
} from './main';
