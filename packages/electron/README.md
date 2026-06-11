# @ipcora/electron

Electron transport adapter for `@ipcora/core`.

```ts
import { ipcMain, BrowserWindow } from "electron";
import { bindBrowserWindow, createElectronIpcora } from "@ipcora/electron";

const ipc = createElectronIpcora({ ipcMain }).handler("ping", () => "pong");

const win = new BrowserWindow();
bindBrowserWindow(ipc, win, { context: {} });
```
