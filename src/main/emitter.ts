import { EMPTY_OBJECT, TYPE_IPC_EMITTER_NAME } from '../constants';
import type { Infer, TIpcSchema, TIpcSchemaType, WebContentsSendData } from '../types';
import { parser } from '../utils';

export interface LikeWebContents {
  send: (channel: string, ...args: any[]) => void;
}

export interface DefineEmitterOptions {
  /**
   * Is validate data before send
   * @default false
   */
  validate?: boolean;
}

export interface DefineEmitterReturn {
  '~name': string;
  static: any;
  (...webContentsList: LikeWebContents[]): Record<string, (data: any) => void>;
}

export function defineEmitter<
  const EmitterName extends string,
  EmitterSchema extends Record<string, any>,
>(name: EmitterName, schema: EmitterSchema, options?: DefineEmitterOptions) {
  const hasSchema = schema && Object.keys(schema).length > 0;
  const { validate = false } = options ?? {};

  function createEmitter(...webContentsList: LikeWebContents[]) {
    const emitter = new Proxy(EMPTY_OBJECT, {
      get(_, method) {
        return async (data: unknown) => {
          if (typeof method !== 'string') throw new Error('Method name must be a string');

          // Only validate if schema exists and options.validate is true
          const parsedData = validate && hasSchema ? await parser(schema[method], data) : data;

          for (const item of webContentsList) {
            try {
              item.send(TYPE_IPC_EMITTER_NAME, {
                name,
                method,
                data: parsedData,
              } satisfies WebContentsSendData);
            } catch (error) {
              console.error(error);
            }
          }
        };
      },
    });

    return emitter as {
      [K in keyof EmitterSchema]: (data: TIpcSchemaType<EmitterSchema[K]>) => Promise<void>;
    };
  }

  return Object.assign(createEmitter, {
    /** @internal */
    '~name': name,
    /** @internal */
    static: null as unknown as {
      readonly [K in keyof EmitterSchema]: TIpcSchemaType<EmitterSchema[K]>;
    },
  });
}

export function registerEmitters<const Emitters extends DefineEmitterReturn[]>(
  ..._emitters: Emitters
) {
  return EMPTY_OBJECT as {
    /** @internal */
    static: {
      [I in Emitters[number] as I['~name']]: {
        [K in keyof Infer<I> as `on${string & K}` | `once${string & K}`]: (
          callback: (data: Infer<I>[K]) => void,
        ) => () => void;
      };
    };
  };
}

export type { TIpcSchema, TIpcSchemaType, WebContentsSendData };
