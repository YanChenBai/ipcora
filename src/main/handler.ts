import type { IpcMainInvokeEvent } from 'electron';
import { app, BaseWindow, BrowserWindow, ipcMain } from 'electron';

import { EMPTY_OBJECT, TYPE_IPC_HANDLER_NAME } from '../constants';
import type { HandlerCallbackEvent, TIpcSchema, TIpcSchemaType } from '../types';
import { parser } from '../utils';

export interface MethodSchema {
  data: TIpcSchema;
  return: TIpcSchema;
}

export interface HandlerListenerEvent {
  invokeEvent: IpcMainInvokeEvent;
  baseWindow: BaseWindow | null;
  browserWindow: BaseWindow | null;
}

export type HandlerMethod<S extends MethodSchema> =
  TIpcSchemaType<S['data']> extends undefined
    ? (event: HandlerListenerEvent) => TIpcSchemaType<S['return']>
    : (event: HandlerListenerEvent, data: TIpcSchemaType<S['data']>) => TIpcSchemaType<S['return']>;

export type HandlerFromSchema<S extends Record<string, MethodSchema>> = {
  [K in keyof S]: HandlerMethod<S[K]>;
};

export interface DefineHandlerReturn {
  /**
   * @internal
   */
  '~name': string;
  static: any;
  (event: IpcMainInvokeEvent, invokeEvent: HandlerCallbackEvent): Promise<any>;
}

export interface DefineHandlerOptions {
  /**
   * Is validate data before handle
   * @default false
   */
  validate?: boolean;
}

/**
 * Define handlers
 * @example
 *
 * // use with schema
 * const myHandler = defineHandler('my-handlers', { }, { hello: { data: Type.String(), return: Type.String() } })
 *
 * // use without schema
 * const myHandler = defineHandler('my-handlers', { hello: (event, data) => 'Hello, world!' })
 *
 * // register
 * registerHandlers(myHandler)
 */
export function defineHandler<
  const Name extends string,
  const Schema extends Record<string, MethodSchema> | undefined = undefined,
  const Methods extends Record<string, (event: HandlerListenerEvent, args: any) => any> = Record<
    string,
    (event: HandlerListenerEvent, args: any) => any
  >,
>(
  name: Name,
  methods: Schema extends Record<string, MethodSchema> ? HandlerFromSchema<Schema> : Methods,
  schema?: Schema,
  options?: DefineHandlerOptions,
) {
  async function listener(
    event: IpcMainInvokeEvent,
    invokeEvent: HandlerCallbackEvent,
  ): Promise<any> {
    const { method, data } = invokeEvent;
    const { validate = false } = options ?? {};
    const handler = methods[method];

    if (!handler) throw new Error(`Handler ${method} not found`);

    const handlerEvent = {
      invokeEvent: event,
      get baseWindow() {
        return BaseWindow.fromId(event.sender.id);
      },
      get browserWindow() {
        return BrowserWindow.fromId(event.sender.id);
      },
    };

    return await Promise.resolve(
      handler(handlerEvent, schema && validate ? await parser(schema[method].data, data) : data),
    );
  }

  return Object.assign(listener, {
    '~name': name,
    /**
     * Generate static call signatures for the renderer side
     * @internal
     */
    static: EMPTY_OBJECT as unknown as {
      [K in keyof Methods]: Methods[K] extends (...args: any[]) => any
        ? (
            ...data: Parameters<Methods[K]>['length'] extends 2
              ? Parameters<Methods[K]> extends [any, ...infer R]
                ? R
                : never
              : []
          ) => Promise<
            { error: null; data: Awaited<ReturnType<Methods[K]>> } | { error: Error; data: null }
          >
        : never;
    },
  });
}

/**
 * Register handlers
 */
export function registerHandlers<const HandlerReturn extends DefineHandlerReturn[]>(
  ...args: HandlerReturn
) {
  let isStart = false;
  const handlersMap = new Map(args.map((item) => [item['~name'], item]));

  function start() {
    if (isStart) return;

    isStart = true;

    ipcMain.handle(TYPE_IPC_HANDLER_NAME, async (event, data: HandlerCallbackEvent) => {
      try {
        const func = handlersMap.get(data.name);
        if (!func) throw new Error(`Handler ${data.name} not found`);

        return {
          error: null,
          data: await func(event, data),
        };
      } catch (error) {
        return {
          error,
          data: null,
        };
      }
    });
  }

  async function appWhenReadyStart() {
    return app.whenReady().then(() => {
      start();
    });
  }

  const returnValue = {
    /**
     * Start TypeIpc
     */
    start,

    /**
     * Start when app ready
     */
    appWhenReadyStart,

    /**
     * Add a handler
     */
    add<const A extends DefineHandlerReturn>(handler: A) {
      handlersMap.set(handler['~name'], handler);
      return returnValue as ReturnType<typeof registerHandlers<[...HandlerReturn, A]>>;
    },

    /**
     * Delete a handler
     */
    del<const A extends DefineHandlerReturn>(handler: A) {
      handlersMap.delete(handler['~name']);
    },

    /**
     * Generate static call signatures for the renderer side
     * @internal
     */
    static: EMPTY_OBJECT as { [K in HandlerReturn[number] as K['~name']]: Readonly<K['static']> },
  };

  return returnValue;
}

export type { HandlerCallbackEvent };
