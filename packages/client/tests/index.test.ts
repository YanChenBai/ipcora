import { describe, expect, test, vi } from 'vitest';

import { createClient } from '../src/index.ts';

const server = {
  window: {
    open(windowId: string) {
      return {
        windowId,
      };
    },

    update(params: { title: string; size: [number, number] }) {
      return params;
    },

    raw: {
      move(windowId: string) {
        return `Hello, ${windowId}`;
      },
    },
  },
};

describe('createClient', () => {
  test('calls a nested method', async () => {
    const invoke = vi.fn(({ channel, args }) => {
      if (channel === 'window.raw.move') {
        return `Hello, ${args[0]}`;
      }
    });

    const client = createClient<typeof server>(server, {
      invoke,
    });

    await expect(client.window.raw.move('window:index:0')).resolves.toEqual({
      data: 'Hello, window:index:0',
      error: null,
    });

    expect(invoke).toHaveBeenCalledOnce();

    expect(invoke).toHaveBeenCalledWith({
      path: ['window', 'raw', 'move'],
      channel: 'window.raw.move',
      namespace: 'window.raw',
      method: 'move',
      args: ['window:index:0'],
    });
  });

  test('calls a top-level namespace method', async () => {
    const invoke = vi.fn(({ args }) => {
      return {
        windowId: args[0],
      };
    });

    const client = createClient<typeof server>(server, {
      invoke,
    });

    await expect(client.window.open('main')).resolves.toEqual({
      data: { windowId: 'main' },
      error: null,
    });

    expect(invoke).toHaveBeenCalledWith({
      path: ['window', 'open'],
      channel: 'window.open',
      namespace: 'window',
      method: 'open',
      args: ['main'],
    });
  });

  test('passes object parameters', async () => {
    const invoke = vi.fn(({ args }) => args[0]);

    const client = createClient<typeof server>(server, {
      invoke,
    });

    const params = {
      title: 'Main Window',
      size: [1280, 720] as [number, number],
    };

    await expect(client.window.update(params)).resolves.toEqual({ data: params, error: null });

    expect(invoke).toHaveBeenCalledWith({
      path: ['window', 'update'],
      channel: 'window.update',
      namespace: 'window',
      method: 'update',
      args: [params],
    });
  });

  test('supports asynchronous invoke', async () => {
    const invoke = vi.fn(async ({ channel, args }) => {
      return {
        channel,
        windowId: args[0],
      };
    });

    const client = createClient<typeof server>(server, {
      invoke,
    });

    await expect(client.window.open('main')).resolves.toEqual({
      data: {
        channel: 'window.open',
        windowId: 'main',
      },
      error: null,
    });
  });

  test('does not expose client as a promise', () => {
    const client = createClient<typeof server>(server, {
      invoke: vi.fn(),
    });

    expect((client as unknown as { then?: unknown }).then).toBeUndefined();
  });

  test('throws when calling a namespace', () => {
    const client = createClient<typeof server>(server, {
      invoke: vi.fn(),
    });

    expect(() => {
      (client.window as unknown as (...args: unknown[]) => unknown)();
    }).toThrow('"window" is a namespace and cannot be called');
  });

  test('throws when accessing an unknown path', () => {
    const client = createClient<typeof server>(server, {
      invoke: vi.fn(),
    });

    expect(() => {
      (
        client as unknown as {
          unknown: {
            method(): unknown;
          };
        }
      ).unknown.method();
    }).toThrow('Unknown client path: "unknown"');
  });

  test('throws when accessing a child property of a method', () => {
    const client = createClient<typeof server>(server, {
      invoke: vi.fn(),
    });

    expect(() => {
      (
        client.window.open as unknown as {
          invalid(): unknown;
        }
      ).invalid();
    }).toThrow('"window.open" is not a namespace');
  });

  test('does not execute the server implementation directly', async () => {
    const move = vi.fn(() => 'server result');

    const definition = {
      window: {
        raw: {
          move,
        },
      },
    };

    const invoke = vi.fn(() => 'client result');

    const client = createClient(definition, {
      invoke,
    });

    await expect(client.window.raw.move()).resolves.toEqual({ data: 'client result', error: null });

    expect(move).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
  });
});

const metaDefinition = {
  noParams: () => 'ok',
  withParams: (name: string) => `Hello, ${name}`,
};

describe('metadata', () => {
  test('static metadata is merged into every call', async () => {
    const invoke = vi.fn(() => 'result');

    const client = createClient(metaDefinition, {
      invoke,
      metadata: { env: 'test', version: 1 },
    });

    await client.noParams();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { env: 'test', version: 1 } }),
    );
  });

  test('onMetadata hook runs per-call and result is merged', async () => {
    const invoke = vi.fn(() => 'result');
    const onMetadata = vi.fn(call => ({ channel: call.channel, dynamic: true }));

    const client = createClient(metaDefinition, {
      invoke,
      onMetadata,
    });

    await client.noParams();

    expect(onMetadata).toHaveBeenCalledOnce();
    expect(onMetadata).toHaveBeenCalledWith(expect.objectContaining({ channel: 'noParams' }));
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { channel: 'noParams', dynamic: true },
      }),
    );
  });

  test('onMetadata hook result overrides static metadata', async () => {
    const invoke = vi.fn(() => 'result');

    const client = createClient(metaDefinition, {
      invoke,
      metadata: { a: 1, b: 2 },
      onMetadata: () => ({ b: 3, c: 4 }),
    });

    await client.noParams();

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { a: 1, b: 3, c: 4 },
      }),
    );
  });

  test('per-call metadata overrides both static and hook', async () => {
    const invoke = vi.fn(() => 'result');

    const client = createClient(metaDefinition, {
      invoke,
      metadata: { a: 1, b: 2 },
      onMetadata: () => ({ b: 3, c: 4 }),
    });

    await client.withParams('alice', { c: 5, d: 6 });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['alice'],
        metadata: { a: 1, b: 3, c: 5, d: 6 },
      }),
    );
  });

  test('per-call metadata on no-params route', async () => {
    const invoke = vi.fn(() => 'result');

    const client = createClient(metaDefinition, { invoke });

    await client.noParams({ traceId: 'abc-123' });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [],
        metadata: { traceId: 'abc-123' },
      }),
    );
  });

  test('per-call metadata on params route as second argument', async () => {
    const invoke = vi.fn(() => 'result');

    const client = createClient(metaDefinition, { invoke });

    await client.withParams('bob', { tenant: 'acme' });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['bob'],
        metadata: { tenant: 'acme' },
      }),
    );
  });

  test('calling without metadata passes undefined metadata', async () => {
    const invoke = vi.fn((_call: any) => 'result');

    const client = createClient(metaDefinition, { invoke });

    await client.noParams();
    await client.withParams('eve');

    expect(invoke).toHaveBeenCalledTimes(2);
    for (const call of invoke.mock.calls) {
      expect(call[0]).not.toHaveProperty('metadata');
    }
  });

  test('non-object per-call arg is not treated as metadata', async () => {
    const invoke = vi.fn((_call: any) => 'result');

    const client = createClient(metaDefinition, { invoke });

    // On a no-params route, passing a string should NOT be metadata
    await client.noParams('not-an-object' as any);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [],
      }),
    );
    expect(invoke.mock.calls[0][0]).not.toHaveProperty('metadata');
  });

  test('async onMetadata hook is supported', async () => {
    const invoke = vi.fn(() => 'result');

    const client = createClient(metaDefinition, {
      invoke,
      onMetadata: async call => {
        await Promise.resolve();
        return { path: call.channel, async: true };
      },
    });

    await client.noParams();

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { path: 'noParams', async: true },
      }),
    );
  });
});
