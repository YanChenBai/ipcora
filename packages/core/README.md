# @ipcora/core

Transport-agnostic typed IPC router for TypeScript.

```ts
import { createIpcora } from '@ipcora/core';
```

Runtime integrations should provide an `IpcTransport` and bind callers as `IpcPeer` values.
