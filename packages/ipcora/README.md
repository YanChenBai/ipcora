# ipcora

Transport-agnostic typed IPC router for TypeScript.

## Install

```bash
pnpm add ipcora
```

## Concepts

An `Ipcora` instance is a **router** that owns:

- **Routes** — named handlers (`"user.get"`, `"admin.stats"`) with typed params, output, and errors
- **Lifecycle hooks** — 12 phases from `onRequest` through `onAfterResponse`
- **Middleware & Plugins** — `use()` chains that extend execution context, or compose entire routers
- **Macros** — reusable hook bundles (e.g. `requireAdmin`)
- **Bindings** — registered peers (callers) that can invoke routes
- **Event definitions** — typed push events emitted to bound peers

The router is **transport-agnostic**: you provide an `IpcAdapter` to wire it into a real IPC channel (Electron `ipcMain`, WebSocket, Node.js `MessagePort`, etc.).

## Quick Start — Memory Adapter

```ts
import { createIpcora, fail, type IpcAdapter } from 'ipcora';

// A minimal in-memory adapter for testing / local-only use
const handlers = new Map<string, Function>();
const adapter: IpcAdapter = {
  handle: (ch, fn) => handlers.set(ch, fn),
  emit: (ch, sender, payload) => sender.send?.(ch, payload),
  listenerCount: ch => (handlers.has(ch) ? 1 : 0),
  removeHandler: ch => handlers.delete(ch),
};

const ipc = createIpcora({ channel: 'app', adapter }).handler('ping', () => 'pong');

// Bind a peer
ipc.bind({ id: 1, sender: { id: 1 } }, { context: {} });

// Invoke
const handler = handlers.get('app')!;
const response = await handler({ sender: { id: 1 } }, { id: 'r1', path: 'ping' });
// { data: "pong" }
```

## Creating a Router

```ts
createIpcora<TContext, TStore>(options?: IpcoraOptions)
```

### Options

| Option        | Type         | Default           | Description                                          |
| ------------- | ------------ | ----------------- | ---------------------------------------------------- |
| `channel`     | `string`     | `"ipcora:invoke"` | IPC channel name used by the adapter                 |
| `name`        | `string`     | —                 | Unique name; prevents duplicate adapter installation |
| `adapter`     | `IpcAdapter` | —                 | Transport bridge (required for runtime)              |
| `abstract`    | `boolean`    | `false`           | Type-only router (no runtime registration)           |
| `exposeStack` | `boolean`    | dev mode          | Include error stacks in responses                    |

## Routes & Handlers

### `.handler(path, fn, options?)`

Register a named handler. The path supports dot notation for nesting.

```ts
const ipc = createIpcora<{ tenant: string }>({ channel: 'app', adapter })
  .handler(
    'user.get',
    ({ params, tenant }) => {
      // params is typed from the schema
      return { id: params.id, tenant };
    },
    {
      params: userParamsSchema, // Standard Schema V1
      output: userOutputSchema, // validates return value
    },
  )
  .handler('ping', () => 'pong');
```

### Handler Context

The handler receives a merged context object:

| Field       | Type                      | Description                                                                  |
| ----------- | ------------------------- | ---------------------------------------------------------------------------- |
| `params`    | schema output             | Validated params (if schema provided)                                        |
| `rawParams` | `unknown`                 | Raw params before validation                                                 |
| `peer`      | `IpcPeer`                 | The bound peer that sent the request                                         |
| `metadata`  | `Record<string, unknown>` | Call metadata                                                                |
| `signal`    | `AbortSignal`             | Abort controller signal                                                      |
| `fail`      | `typeof fail`             | Factory for typed errors                                                     |
| `store`     | `TStore`                  | Shared mutable state                                                         |
| `id`        | `string`                  | Request ID                                                                   |
| `path`      | `string`                  | Route path                                                                   |
| ...context  | `TContext`                | All context extensions (state, decorate, derive, resolve, middleware, guard) |

### Returning Errors

```ts
import { fail } from 'ipcora';

ipc.handler('protected', ({ fail, isAdmin }) => {
  if (!isAdmin) throw fail('FORBIDDEN', { message: 'Admin only' });
  return 'ok';
});
```

`fail()` returns an `IpcError` — a typed `Error` subclass with `name`, `message`, optional `data`, and optional `cause`.

## Groups

```ts
ipc.group('admin', admin =>
  admin.handler('stats', () => ({ users: 42 })).handler('config', () => ({ debug: false })),
);
// Registers: "admin.stats", "admin.config"
```

Groups inherit parent hooks, middleware, and macros. You can add group-specific middleware.

## Lifecycle Hooks

Every request flows through 12 phases. Phases 1–11 execute in order; `onError` runs instead of `onAfterResponse` when an error occurs. `onAfterResponse` always runs last.

```
onRequest
  → onTransform
  → derive
  → onGuard
  → validation          (Standard Schema — not user-registerable)
  → resolve
  → onBeforeHandle
  → handler
  → onAfterHandle
  → onMapResponse
  → (success) onAfterResponse
  → (error)   onError → onAfterResponse
```

### Hooks

Hooks can be registered **globally** (`.onRequest(...)`) or **locally** (per `handler()` options).

#### `.onRequest(hook)`

First hook. Inspect the raw request before any processing.

```ts
ipc.onRequest(({ id, path, request }) => {
  console.log(`[${id}] ${path}`);
});
```

#### `.onTransform(hook)`

Normalize raw params before validation. Return transformed params or void to keep original.

```ts
ipc.onTransform(({ params }) => {
  if (params && typeof params === 'object') {
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      trimmed[k] = typeof v === 'string' ? v.trim() : v;
    }
    return trimmed;
  }
});
```

#### `.derive(hook)`

Derive context from raw request data. Runs **before** validation. Return value merges into handler context.

```ts
ipc.derive(({ rawParams, metadata }) => ({
  rawType: typeof rawParams,
  hasMetadata: metadata != null && Object.keys(metadata).length > 0,
}));
```

#### `validation` _(internal phase)_

Standard Schema validation of params against the route's schema. Not a registerable hook, but reported in `onError` phase info.

#### `.resolve(hook)`

Derive context from parsed (validated) params. Runs **after** validation.

```ts
ipc.resolve(({ peer, metadata }) => ({
  requestId: `req-${peer.id}-${Date.now()}`,
}));
```

#### `.onGuard(hook)`

Permission / role resolution. Runs **before** validation — guards can short-circuit early without paying schema validation cost. Receives raw (unvalidated) params. Return value merges into context.

```ts
ipc.onGuard(({ params, metadata, fail }) => {
  const user = metadata.user as { role: string } | undefined;
  if (!user) throw fail('UNAUTHORIZED');
  return { isAdmin: user.role === 'admin' };
});
```

#### `.onBeforeHandle(hook)`

Final guard before the handler executes. Can inspect signal for abort.

```ts
ipc.onBeforeHandle(({ signal, fail }) => {
  if (signal.aborted) throw fail('ABORTED', { message: 'Request aborted' });
});
```

#### `.onAfterHandle(hook)`

Transform or inspect the handler's return value. Return a new value to replace the output.

```ts
ipc.onAfterHandle(({ output }) => {
  if (output && typeof output === 'object') {
    return { ...output, _timestamp: Date.now() };
  }
});
```

#### `.onMapResponse(hook)`

Final chance to rewrite the full response shape (`{ data }` or `{ error }`).

```ts
ipc.onMapResponse(({ response }) => {
  // Add a wrapper envelope
  return { ...response, _version: 2 };
});
```

#### `.onError(hook)` _(error path)_

Catch and potentially rewrite errors. Can return a new response, a new `fail()`, or `undefined` to pass through the default error.

```ts
ipc.onError(({ name, phase, error, fail }) => {
  console.error(`Error "${name}" in phase "${phase}"`);
  if (name === 'DB_UNAVAILABLE') {
    return { error: { name, message: 'Please try again later' } };
  }
});
```

The hook receives:
| Field | Type | Description |
|---|---|---|
| `name` | `string` | Error name |
| `message` | `string` | Error message |
| `error` | `IpcError` | Full IpcError object |
| `phase` | `LifecyclePhase` | The phase in which the error occurred |
| `cause` | `unknown` | Original error cause |
| `fail` | `typeof fail` | Factory to create a new error |

#### `.onAfterResponse(hook)`

Always runs last, whether success or error. Fire-and-forget — return value is ignored.

```ts
ipc.onAfterResponse(({ success, duration, path, phase }) => {
  if (!success) {
    console.warn(`FAIL ${path} in ${phase} (${duration.toFixed(1)}ms)`);
  }
});
```

Receives: `success`, `duration`, `response`, `output`, `params`, `cause`, `phase`.

## Middleware & Plugins

`use()` accepts two kinds of arguments:

### Middleware function

```ts
ipc.use<{ logger: Logger }>((ctx, next) => {
  const start = Date.now();
  const result = next({ logger: createLogger(ctx.path) });
  console.log(`${ctx.path} took ${Date.now() - start}ms`);
  return result;
});
```

Middleware context merges with `derive`/`resolve` context and is available to all downstream hooks and the handler.

### Plugin (another Ipcora instance)

You can compose routers by `use()`-ing one Ipcora instance into another. The plugin's routes, middleware, hooks, macros, error mappers, state, and decorators are merged into the parent.

```ts
// Define a reusable auth plugin
const authPlugin = createIpcora({ name: 'auth' })
  .macro('requireAuth', {
    onGuard({ fail }) {
      throw fail('UNAUTHORIZED');
    },
  })
  .handler('auth.login', () => 'token');

// Use it in the main app
const app = createIpcora({ channel: 'app', adapter })
  .use(authPlugin)
  .handler('ping', () => 'pong');
```

**Singleton behavior:** Named plugins (with a `name`) can only be `use()`d once — calling `use()` with the same named plugin a second time throws. Unnamed plugins can be reused across different parent routers, but using the same unnamed plugin twice in the same parent throws (because route paths would conflict).

**Merge strategy:**

- Routes: merged; duplicate paths throw
- Hooks: parent hooks run first, plugin hooks run second
- Middleware: parent middleware wraps plugin middleware (onion model)
- Macros / error mappers: merged; parent wins on conflict
- State / decorators: merged; parent wins on conflict

## Macros

Reusable hook bundles with typed options. Macros compose lifecycle hooks, schemas, guard logic, and transformations into a single keyword that can be referenced in any `handler()` options.

### Object form — static hooks

```ts
ipc.macro("requireAdmin", {
  onGuard({ isAdmin, fail }) {
    if (!isAdmin) throw fail("FORBIDDEN", { message: "Admin role required" });
  },
  onAfterHandle({ output }) {
    console.log("Admin action:", output);
  },
});

// Usage — option value is `true` (just enables the macro)
ipc.handler("admin.dashboard", () => ({ ... }), {
  requireAdmin: true,
});
```

### Factory form — dynamic hooks

```ts
ipc.macro('rateLimit', (maxCalls: number) => ({
  onBeforeHandle({ store, path, fail }) {
    const key = `rate:${path}`;
    const count = (store[key] ?? 0) + 1;
    store[key] = count;
    if (count > maxCalls) throw fail('RATE_LIMITED', { message: `Max ${maxCalls} calls` });
  },
}));

// Usage — option value is the factory parameter
ipc.handler('api.search', ({ params }) => search(params), {
  rateLimit: 100, // maxCalls = 100
});

ipc.handler('api.upload', upload, {
  rateLimit: 10, // maxCalls = 10
});
```

### The `option` field

When a macro hook runs, the option value is available as `option` in the hook context:

```ts
ipc.macro('loggable', {
  onBeforeHandle({ path, option }) {
    console.log(`[macro:loggable] ${path}:${option}`);
  },
});

ipc.handler('checkout', pay, { loggable: 'checkout-audit' });
// option === "checkout-audit"
```

### Nested macros

A macro can reference another macro. The expansion auto-deduplicates to prevent infinite loops:

```ts
ipc
  .macro('audited', {
    onAfterHandle({ output }) {
      console.log('Audit:', output);
    },
  })
  .macro('secure', {
    requireAdmin: true, // ← references the requireAdmin macro
    audited: true, // ← references the audited macro
  });

ipc.handler('deleteUser', deleteFn, { secure: true });
// Runs: onGuard (requireAdmin) → handler → onAfterHandle (audited)
```

### `option === false` skips the macro

```ts
ipc.handler('public.info', infoFn, { requireAdmin: false });
// Macro is skipped entirely
```

### Macro lifecycle hooks

A macro definition can include any of these hook keys:

```ts
ipc.macro('fullAudit', {
  onRequest({ id, option }) {
    /* ... */
  },
  onTransform({ params }) {
    /* return transformed params */
  },
  derive({ rawParams, option }) {
    /* return context extension */
  },
  resolve({ params, option }) {
    /* return context extension */
  },
  onGuard({ option, fail }) {
    /* permission check */
  },
  onBeforeHandle({ option }) {
    /* pre-handler guard */
  },
  onAfterHandle({ output }) {
    /* transform output */
  },
  onMapResponse({ response }) {
    /* rewrite response */
  },
  onError({ name, error }) {
    /* rewrite error */
  },
  onAfterResponse({ success }) {
    /* logging */
  },
  params: mySchema, // appended to route params schemas
  output: myOutputSchema, // appended to route output schemas
});
```

All hooks receive the `option` value from the handler options. `derive`, `resolve`, and `onGuard` can return context extensions.

## State & Decorators

```ts
const ipc = createIpcora({ channel: 'app', adapter })
  .state('counter', 0) // mutable, shared across all peers
  .state({ config: { debug: true } }) // batch form
  .decorate('version', '2.0') // static, per-request copy
  .decorate({ region: 'us-east-1' });

ipc.handler('inc', ({ store, version }) => {
  store.counter += 1;
  return { count: store.counter, version };
});
```

## Events

```ts
import { defineEventSchema } from 'ipcora/event';
import { z } from 'zod'; // or arktype, valibot, etc.

const ipc = createIpcora({ channel: 'app', adapter }).events(
  defineEventSchema({
    userLogin: z.object({ userId: z.string(), at: z.number() }),
  }),
);

// Emit to all bound peers
ipc.$emit.userLogin({ userId: 'u1', at: Date.now() });

// Emit to specific peers
ipc.$emit.userLogin({ userId: 'u1', at: Date.now() }, { peers: [peer1, peer2] });
```

## Creating a Typed Client

Install and import from `ipcora/client`:

```ts
import { createClient, type InferDefinition } from 'ipcora/client';

type Def = InferDefinition<typeof ipc>;
const client = createClient<Def>({
  invoke(call) {
    // call.channel — dotted path like "user.get"
    // call.args    — params array
    // call.metadata — merged metadata
    return transport.invoke(call.channel, call.args[0], call.metadata);
  },
  subscribe(call) {
    // call.channel  — event channel like "app:event:userLogin"
    // call.listener — payload callback
    // call.once     — boolean
    return transport.subscribe(call.channel, call.listener);
  },
  metadata: { appVersion: '1.0' }, // static metadata
  onMetadata: call => ({ traceId: '...' }), // dynamic per-call metadata
});

// Typed invoke
const user = await client.invoke.user.get({ id: '1' });

// Typed events
const unsub = client.event.onUserLogin(({ userId, at }) => {
  console.log(`${userId} logged in at ${at}`);
});
```

### Client Types

| Export                  | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `createClient<T>(opts)` | Factory function                                    |
| `Client<T>`             | `{ invoke, event }` typed proxy                     |
| `InferDefinition<T>`    | Extract route & event types from an Ipcora instance |
| `CreateClientOptions`   | Options type for `createClient`                     |
| `ClientCall`            | Shape passed to `invoke` adapter                    |
| `ClientSubscription`    | Shape passed to `subscribe` adapter                 |

## Custom Adapter

Implement the `IpcAdapter` interface to connect to any transport:

```ts
interface IpcAdapter<TEvent extends IpcEvent = IpcEvent> {
  handle(
    channel: string,
    handler: (event: TEvent, request: IpcRequest) => MaybePromise<IpcResponse>,
  ): void;
  emit(channel: string, sender: TEvent['sender'], payload: unknown): MaybePromise<void>;
  listenerCount(channel: string): number;
  removeHandler(channel: string): void;
}
```

## Error Mapping

Map custom `Error` subclasses to typed `IpcError` payloads:

```ts
class DatabaseError extends Error {}
class ValidationError extends Error {}

ipc
  .error(DatabaseError, ({ fail, error }) => fail('DB_UNAVAILABLE', { message: error.message }))
  .error(ValidationError, ({ fail, error }) =>
    fail('VALIDATION_CUSTOM', { message: error.message }),
  );
```

## Abstract Routers

Type-only routers for sharing definitions without runtime overhead:

```ts
const types = createIpcora({ abstract: true }).handler(
  'user.get',
  (params: string) => ({}) as { id: string },
);

// types.definition carries full type info
// types.bind() is a no-op — no adapter calls
```

## Type Reference

### Main exports (`ipcora`)

| Export         | Kind     | Description                         |
| -------------- | -------- | ----------------------------------- |
| `createIpcora` | function | Create a router instance            |
| `fail`         | function | Create a typed `IpcError`           |
| `IpcError`     | class    | Typed error class                   |
| `Ipcora`       | class    | Router class (for type annotations) |

### Client exports (`ipcora/client`)

| Export                | Kind     | Description                      |
| --------------------- | -------- | -------------------------------- |
| `createClient`        | function | Create a typed Proxy client      |
| `Client`              | type     | Client shape `{ invoke, event }` |
| `InferDefinition`     | type     | Extract type from router         |
| `CreateClientOptions` | type     | Options for `createClient`       |
| `ClientMetadata`      | type     | Metadata value type              |
| `Unsubscribe`         | type     | Cleanup function type            |

### Event exports (`ipcora/event`)

| Export              | Kind     | Description                             |
| ------------------- | -------- | --------------------------------------- |
| `defineEventSchema` | function | Identity helper for typed event schemas |
