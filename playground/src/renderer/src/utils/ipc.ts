import { createIpcInvoke, createIpcMessage } from 'type-ipc';

import type { Invoke, Message } from '../../../main/type-ipc';

export const ipcInvoke = createIpcInvoke<Invoke>();
export const ipcMessage = createIpcMessage<Message>();
