import Type from 'typebox';
import { describe, expectTypeOf, it } from 'vite-plus/test';

import { createIpcInvoke, createIpcMessage, createThrowIpcInvoke } from '../src';
import type { Infer, LikeWebContents } from '../src/main';
import { defineEmitter, defineHandler, registerEmitters, registerHandlers } from '../src/main';

const useSchemaHandler = defineHandler(
  'useSchema',
  {
    hello(event, data: number) {
      return data;
    },
  },
  {
    hello: {
      data: Type.Number(),
      return: Type.Number(),
    },
  },
);

const noSchemaInHandler = defineHandler('noSchema', {
  hello(_event, data: number) {
    return data;
  },
});

const handlers = registerHandlers(useSchemaHandler, noSchemaInHandler);

type Invokes = Infer<typeof handlers>;

type HandlerAnswer = Readonly<{
  readonly hello: (data: number) => Promise<
    | {
        error: null;
        data: number;
      }
    | {
        error: Error;
        data: null;
      }
  >;
}>;

const useSchemaEmitter = defineEmitter('useSchema', { Hello: Type.String() });
const noSchemaEmitter = defineEmitter('noSchema', {} as { Hello: string });

const emitters = registerEmitters(useSchemaEmitter, noSchemaEmitter);

type Messages = Infer<typeof emitters>;

type EmitterAnswer = Readonly<{
  readonly onHello: (callback: (data: string) => void) => () => void;
  readonly onceHello: (callback: (data: string) => void) => () => void;
}>;

describe('types work properly', () => {
  it('defineEmitter', () => {
    expectTypeOf(useSchemaEmitter).toBeFunction();

    expectTypeOf(useSchemaEmitter).parameters.toEqualTypeOf<LikeWebContents[]>();

    expectTypeOf(useSchemaEmitter).returns.toEqualTypeOf<{
      Hello: (data: string) => Promise<void>;
    }>();

    expectTypeOf(noSchemaEmitter).returns.toEqualTypeOf<{
      Hello: (data: string) => Promise<void>;
    }>();

    expectTypeOf(useSchemaEmitter['~name']).toEqualTypeOf<'useSchema'>();
    expectTypeOf(noSchemaEmitter['~name']).toEqualTypeOf<'noSchema'>();

    expectTypeOf(useSchemaEmitter.static).toMatchObjectType<{
      readonly Hello: string;
    }>();

    expectTypeOf(noSchemaEmitter.static).toMatchObjectType<{
      readonly Hello: string;
    }>();
  });

  it('defineHandler', () => {
    expectTypeOf(useSchemaHandler['~name']).toEqualTypeOf<'useSchema'>();
    expectTypeOf(noSchemaInHandler['~name']).toEqualTypeOf<'noSchema'>();

    expectTypeOf(useSchemaHandler.static).toEqualTypeOf<HandlerAnswer>();
    expectTypeOf(noSchemaInHandler.static).toEqualTypeOf<HandlerAnswer>();
  });

  it('registerEmitters', () => {
    expectTypeOf(emitters.static).toEqualTypeOf<{
      useSchema: EmitterAnswer;
      noSchema: EmitterAnswer;
    }>();
  });

  it('registerHandlers', () => {
    expectTypeOf(handlers.static).toMatchObjectType<{
      useSchema: HandlerAnswer;
      noSchema: HandlerAnswer;
    }>();
  });

  it('createIpcInvoke', () => {
    const ipcInvoke = createIpcInvoke<Invokes>();
    const ThrowIpcInvoke = createThrowIpcInvoke<Invokes>();

    expectTypeOf(ipcInvoke).toMatchObjectType<{
      useSchema: HandlerAnswer;
      noSchema: HandlerAnswer;
    }>();

    expectTypeOf(ThrowIpcInvoke).toMatchObjectType<{
      useSchema: {
        readonly hello: (data: number) => Promise<number>;
      };
      noSchema: {
        readonly hello: (data: number) => Promise<number>;
      };
    }>();
  });

  it('createIpcMessage', () => {
    const ipcMessage = createIpcMessage<Messages>();

    expectTypeOf(ipcMessage).toMatchObjectType<{
      useSchema: EmitterAnswer;
      noSchema: EmitterAnswer;
    }>();
  });
});
