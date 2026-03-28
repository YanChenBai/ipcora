import { EMPTY_OBJECT, TYPE_IPC_EXPOSE_NAME } from './constants';
import type { HandlerCallbackEvent, Infer, SenderCallbackEvent } from './types';

type InvokeReturn<Data = unknown> = { error: Error; data: null } | { error: null; data: Data };

declare global {
  interface Window {
    [TYPE_IPC_EXPOSE_NAME]: {
      invoke: (data: HandlerCallbackEvent) => Promise<InvokeReturn>;
      /**
       * @param data Event Data
       * @returns Remove listener
       */
      message: (data: SenderCallbackEvent) => () => void;
    };
  }
}

export function createProxy<T extends Record<string, Record<string, any>>>(
  get: (name: string, method: string, data?: any) => any,
) {
  return new Proxy(EMPTY_OBJECT, {
    get(_, name) {
      return new Proxy(EMPTY_OBJECT, {
        get(_, method) {
          return (data?: any) => get(name.toString(), method.toString(), data);
        },
      });
    },
  }) as T;
}

let TypeIpcInvoke: any = null;
export function createIpcInvoke<
  Invoke extends Record<string, Record<string, (...args: any[]) => Promise<InvokeReturn>>>,
>(): Invoke {
  if (TypeIpcInvoke) return TypeIpcInvoke;

  return (TypeIpcInvoke = createProxy((name, method, data) => {
    return window[TYPE_IPC_EXPOSE_NAME].invoke({ name, method, data });
  }));
}

export function createThrowIpcInvoke<
  Invoke extends Record<string, Record<string, (...args: any[]) => Promise<InvokeReturn>>>,
  InvokeThrow = {
    [NS in keyof Invoke]: {
      [M in keyof Invoke[NS]]: (
        ...args: Parameters<Invoke[NS][M]>
      ) => Invoke[NS][M] extends (...args: any[]) => Promise<InvokeReturn<infer D>>
        ? Promise<D>
        : never;
    };
  },
>(): InvokeThrow {
  if (TypeIpcInvoke) return TypeIpcInvoke;

  return (TypeIpcInvoke = createProxy(async (name, method, data) => {
    const res = await window[TYPE_IPC_EXPOSE_NAME].invoke({ name, method, data });

    if (res.error) throw res.error;

    return res.data;
  }));
}

let TypeIpcMessage: any = null;
export function createIpcMessage<
  Message extends Record<
    string,
    Record<`on${string}`, (callback: (...args: any[]) => any) => () => void>
  >,
>(): Message {
  if (TypeIpcMessage) return TypeIpcMessage;

  return (TypeIpcMessage = createProxy((name, method, callback) => {
    return window[TYPE_IPC_EXPOSE_NAME].message({ name, method, callback });
  }));
}

export type { HandlerCallbackEvent, Infer, SenderCallbackEvent };
