# ipcora

Typed IPC routing for TypeScript — a transport-agnostic core with first-class Electron support.

## Packages

| Package                                    | Description                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [`ipcora`](./packages/ipcora/)             | Route registration, lifecycle hooks, middleware, macros, context, schema validation |
| [`@ipcora/electron`](./packages/electron/) | Electron adapter — main / preload / renderer                                        |

## Install

```bash
pnpm add ipcora
pnpm add @ipcora/electron electron
```

## Quick Start

### Core — memory adapter

```ts
import { createIpcora, fail } from 'ipcora';
import { createClient, type InferDefinition } from 'ipcora/client';

// 1. Define a router
const ipc = createIpcora<{ tenant: string }>({
  channel: 'app:ipc',
  adapter: memoryAdapter,
})
  .state('users', new Map<string, { name: string }>())
  .handler('user.get', ({ params, store }) => {
    const user = store.users.get(params.id);
    if (!user) throw fail('NOT_FOUND', { message: `User ${params.id} not found` });
    return user;
  });

// 2. Bind a peer
ipc.bind({ id: 1, sender: { id: 1 } }, { context: { tenant: 'acme' } });

// 3. Create a typed client
type Def = InferDefinition<typeof ipc>;
const client = createClient<Def>(ipc.definition, { invoke });
const result = await client.invoke.user.get({ id: '1' });
//    ^ { data: { name: string } | null; error: { name: string; message: string } | null }
```

### Electron — full stack

**main process** (`src/main/ipc.ts`) — register handlers & export types:

```ts
import { createElectronIpcora } from '@ipcora/electron';
import { ipcMain } from 'electron';

export const ipc = createElectronIpcora({ channel: 'app:ipc', ipcMain }).handler(
  'ping',
  () => 'pong',
);

export type AppIpcora = typeof ipc;
```

**main process** (`src/main/index.ts`) — bind windows:

```ts
import { BrowserWindow } from 'electron';
import { bindBrowserWindow } from '@ipcora/electron';
import { ipc } from './ipc';

const win = new BrowserWindow({
  webPreferences: { preload: path.join(__dirname, '../preload/index.js') },
});
bindBrowserWindow(ipc, win, { context: {} });
```

**preload script** — expose the bridge:

```ts
import { exposeIpcoraBridge } from '@ipcora/electron/preload';
exposeIpcoraBridge({ channel: 'app:ipc' });
```

**renderer** — call handlers with full type safety:

```ts
import { createIpcoraClient, type InferDefinition } from '@ipcora/electron/renderer';
import type { AppIpcora } from '../main/ipc';

const client = createIpcoraClient<InferDefinition<AppIpcora>>({});
const result = await client.invoke.ping();
//    ^ { data: "pong"; error: null }
```

## Features

- **Fully typed** — routes, params, output, errors, events, and context all inferred
- **Lifecycle hooks** — 12 hooks from `onRequest` through `onAfterResponse`
- **Middleware** — extensible context via `use()`
- **Macros** — reusable hook bundles with options: `.macro("requireAdmin", { ... })`
- **Schema validation** — [Standard Schema](https://standardschema.dev/) for params & output
- **Event system** — typed push events from server to peers
- **Transport agnostic** — adapters for Electron, memory, or any custom transport
- **Tree-shakeable** — `ipcora/client`, `ipcora/event`, `@ipcora/electron/main|preload|renderer`

## Development

```bash
pnpm install
pnpm -F ipcora test
pnpm -F @ipcora/electron test
pnpm -F ipcora build
pnpm -F @ipcora/electron build
```
