# @ipcora/electron

Electron integration for `ipcora` — typed IPC across main, preload, and renderer processes.

## Install

```bash
pnpm add @ipcora/electron electron ipcora
```

> `electron` and `ipcora` are peer dependencies.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Main Process                                            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ @ipcora/electron/main                               │ │
│ │ createElectronIpcora()                              │ │
│ │   .handler("user.get", ({ params }) => ...)         │ │
│ │ ipc.bind(win)                                       │ │
│ └─────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────┘
                     │ ipcMain.handle / webContents.send
┌────────────────────┴────────────────────────────────────┐
│ Preload Script                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ @ipcora/electron/preload                            │ │
│ │ exposeIpcoraBridge()                                │ │
│ │ // → window.__IPCORA__ = { invoke, subscribe }      │ │
│ └─────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────┘
                     │ contextBridge
┌────────────────────┴────────────────────────────────────┐
│ Renderer Process                                        │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ @ipcora/electron/renderer                           │ │
│ │ createIpcoraClient<Def>()                           │ │
│ │ client.invoke.user.get({ id: "1" })   // typed!     │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Modules

| Import                      | Use in                             |
| --------------------------- | ---------------------------------- |
| `@ipcora/electron`          | Main process (re-exports `./main`) |
| `@ipcora/electron/main`     | Main process                       |
| `@ipcora/electron/preload`  | Preload script                     |
| `@ipcora/electron/renderer` | Renderer process                   |

---

## Main Process

### `createElectronIpcora(options?)` → `ElectronIpcora`

Create a fully typed ipcora router backed by Electron's `ipcMain`. The Electron channel is fixed internally, and the returned router can bind `BrowserWindow` instances directly.

```ts
import { createElectronIpcora } from '@ipcora/electron';
// or: import { createElectronIpcora } from "@ipcora/electron/main";

const ipc = createElectronIpcora<{ tenant: string }>()
  .state('users', new Map())
  .handler('ping', () => 'pong')
  .handler('user.get', ({ params, store }) => {
    return store.users.get(params.id);
  });
```

### `ipc.bind(window, options?)` → `BoundBrowserWindow`

Bind a `BrowserWindow` as a callable peer. Returns a per-window handle with `emit`, `$emit`, and `unbind`.

```ts
import { BrowserWindow } from 'electron';

const win = new BrowserWindow({
  /* ... */
});

const binding = ipc.bind(win, {
  context: { tenant: 'acme-corp' }, // merged into handler context
});

// binding.emit(...) sends typed events to this window.
binding.unbind();

// The BrowserWindow.id becomes the peer ID.
// When the window closes, the peer auto-unbinds.
```

`context` is optional. Use it when handlers need per-window values such as tenant, authenticated user, role, or session state.

### `createElectronAdapter(ipcMain)` → `ElectronIpcAdapter`

Low-level adapter factory. Use if you need the raw adapter without creating a full ipcora instance.

```ts
import { createElectronAdapter } from '@ipcora/electron';

const adapter = createElectronAdapter(ipcMain);
adapter.handle('my-channel', (event, request) => {
  // event.sender is WebContents
  return { data: 'ok' };
});
```

### `createBrowserWindowPeer(window)` → `ElectronIpcPeer`

Wrap a `BrowserWindow` as an `IpcPeer` without binding. Useful for advanced peer management.

```ts
import { createBrowserWindowPeer } from '@ipcora/electron';

const peer = createBrowserWindowPeer(myWindow);
peer.id; // BrowserWindow.id
peer.sender; // webContents (used for emit/send)
peer.window; // BrowserWindow reference
```

### Main Process Types

```ts
import type {
  ElectronIpcEvent, // IpcMainInvokeEvent & IpcEvent<WebContents>
  ElectronIpcMain, // Pick<IpcMain, "handle" | "listenerCount" | "removeHandler">
  ElectronIpcAdapter, // IpcAdapter<ElectronIpcEvent>
  ElectronIpcora, // Ipcora with BrowserWindow-aware bind(...)
  ElectronIpcoraOptions, // IpcoraOptions without adapter/channel
  ElectronIpcPeer, // IpcPeer<WebContents> & { window: BrowserWindow }
  BoundBrowserWindow,
} from '@ipcora/electron';
```

---

## Preload Script

### `exposeIpcoraBridge(options?)`

Call once in your preload script. Uses `contextBridge.exposeInMainWorld` to safely expose `invoke` and `subscribe` to the renderer.

```ts
// preload.ts
import { exposeIpcoraBridge } from '@ipcora/electron/preload';

exposeIpcoraBridge();
```

After this call, `window.__IPCORA__` exposes:

```ts
window.__IPCORA__.invoke(request: IpcRequest): Promise<IpcResponse>
window.__IPCORA__.subscribe(eventChannel: string, listener: (payload: unknown) => void): () => void
```

### Preload Types

```ts
import type { IpcoraBridge } from '@ipcora/electron/preload';
```

---

## Renderer Process

### `createIpcoraClient(options?)` → `Client`

Create a fully typed Proxy client backed by the preload bridge.

```ts
// renderer.ts
import { createIpcoraClient, type InferDefinition } from '@ipcora/electron/renderer';
import type { AppIpcora } from '../main/ipc'; // type-only import — zero runtime cost

const client = createIpcoraClient<InferDefinition<AppIpcora>>({
  metadata: { appVersion: '1.0' }, // static metadata
  onMetadata: call => ({ traceId: '...' }), // dynamic per-call metadata
});

// Typed invoke
const user = await client.invoke.user.get({ id: '1' });
//    ^ { data: { id: string; name: string; email: string } | null;
//        error: { name: string; message: string } | null }

const pong = await client.invoke.ping();
//    ^ { data: "pong"; error: null }

// Typed events
const unsub = client.event.onUserLogin(({ userId, at }) => {
  console.log(`${userId} logged in at ${new Date(at).toISOString()}`);
});
```

### Options

| Option       | Type                                | Default | Description                            |
| ------------ | ----------------------------------- | ------- | -------------------------------------- |
| `metadata`   | `Record<string, unknown>`           | —       | Static metadata merged into every call |
| `onMetadata` | `(call) => Record<string, unknown>` | —       | Dynamic per-call metadata hook         |

### Renderer Types

```ts
import type {
  CreateIpcoraClientOptions,
  InferDefinition,
  Client,
  CreateClientOptions,
} from '@ipcora/electron/renderer';
```

---

## Full Example

### `src/main/ipc.ts` (main process — shared types)

```ts
import { createElectronIpcora, fail } from '@ipcora/electron';

export const ipc = createElectronIpcora<{ tenant: string }, { users: Map<string, User> }>()
  .state('users', new Map<string, User>())
  .handler('user.create', ({ params, store }) => {
    const user = { id: crypto.randomUUID(), ...params };
    store.users.set(user.id, user);
    return user;
  })
  .handler('user.get', ({ params, store, fail }) => {
    const user = store.users.get(params.id);
    if (!user) throw fail('NOT_FOUND', { message: `User ${params.id} not found` });
    return user;
  });

export type AppIpcora = typeof ipc;
```

### `src/main/index.ts` (main process — bind windows)

```ts
import { BrowserWindow } from 'electron';
import { ipc } from './ipc';

function createWindow() {
  const win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') },
  });
  ipc.bind(win, { context: { tenant: 'default' } });
  return win;
}
```

### `src/preload/index.ts` (preload script)

```ts
import { exposeIpcoraBridge } from '@ipcora/electron/preload';
exposeIpcoraBridge();
```

### `src/renderer/app.ts` (renderer)

```ts
import { createIpcoraClient, type InferDefinition } from '@ipcora/electron/renderer';
import type { AppIpcora } from '../main/ipc';

const client = createIpcoraClient<InferDefinition<AppIpcora>>();

// Create a user
const newUser = await client.invoke.user.create({ name: 'Alice', email: 'alice@acme.com' });
if (newUser.data) {
  console.log('Created:', newUser.data.id);
}

// Get a user
const result = await client.invoke.user.get({ id: newUser.data!.id });
if (result.error) {
  console.error(`${result.error.name}: ${result.error.message}`);
} else {
  console.log('Found:', result.data.name);
}
```

---

## Reference

### Electron-Specific Types

| Type                        | Shape                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| `ElectronIpcEvent`          | `IpcMainInvokeEvent & IpcEvent<WebContents>`                      |
| `ElectronIpcMain`           | `Pick<IpcMain, "handle" \| "listenerCount" \| "removeHandler">`   |
| `ElectronIpcAdapter`        | `IpcAdapter<ElectronIpcEvent>`                                    |
| `ElectronIpcora`            | `Ipcora` with `bind(window, options?)`                            |
| `ElectronIpcoraOptions`     | `IpcoraOptions` without `adapter` or `channel`                    |
| `ElectronIpcPeer`           | `IpcPeer<WebContents> & { window: BrowserWindow }`                |
| `BoundBrowserWindow`        | `{ id, window, emit, $emit, unbind }`                             |
| `IpcoraBridge`              | `{ invoke, subscribe }` — exposed to renderer via `contextBridge` |
| `CreateIpcoraClientOptions` | `{ metadata?, onMetadata? }`                                      |

### How Events Work

```
Router: ipc.$emit.userLogin(payload)
  → adapter.emit("ipcora:electron:event:userLogin", webContents, payload)
  → webContents.send("ipcora:electron:event:userLogin", payload)

Preload bridge: ipcRenderer.on("ipcora:electron:event:userLogin", handler)
  → bridge.subscribe("app:ipc:event:userLogin", listener)

Client: client.event.onUserLogin(listener)
  → createEventSubscriber → bridge.subscribe(...)
```

The event channel format is always `ipcora:electron:event:{eventName}`.
