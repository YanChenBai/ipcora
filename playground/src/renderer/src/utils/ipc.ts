import type { Invoke, Message } from 'src/main/type-ipc';
import { createIpcInvoke, createIpcMessage } from 'type-ipc';

export const ipcInvoke = createIpcInvoke<Invoke>();
export const ipcMessage = createIpcMessage<Message>();
