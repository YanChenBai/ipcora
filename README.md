# ipcora

Typed IPC routing for TypeScript, split into a transport-agnostic core and runtime adapters.

## Packages

- `@ipcora/core`: route registration, lifecycle hooks, middleware, macros, context, and Standard Schema validation.
- `@ipcora/electron`: Electron `ipcMain` and `BrowserWindow` adapter for `@ipcora/core`.

## Install

```bash
vp add @ipcora/core
vp add @ipcora/electron electron
```

## Core Usage

```ts
import { createIpcora, type IpcTransport } from '@ipcora/core';

const transport: IpcTransport = {
  handle(channel, handler) {
    // Connect this to your runtime's request handler.
  },
  listenerCount(channel) {
    return 0;
  },
  removeHandler(channel) {
    // Remove the runtime handler.
  },
};

const ipc = createIpcora<{ tenant: string }>({
  channel: 'ipcora:invoke',
  transport,
}).handler('ping', ({ context }) => {
  return { pong: context.tenant };
});
```

## Electron Usage

```ts
import { BrowserWindow, ipcMain } from 'electron';
import { bindBrowserWindow, createElectronIpcora } from '@ipcora/electron';

const ipc = createElectronIpcora<{ tenant: string }>({
  channel: 'ipcora:invoke',
  ipcMain,
}).handler('ping', ({ context }) => {
  return { pong: context.tenant };
});

const win = new BrowserWindow();
bindBrowserWindow(ipc, win, {
  context: { tenant: 'acme' },
});
```

## Development

```bash
vp install
vp run @ipcora/core#test
vp run @ipcora/electron#test
vp run @ipcora/core#build
vp run @ipcora/electron#build
```
