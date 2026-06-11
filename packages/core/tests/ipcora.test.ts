import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createIpcora,
  createIpcError,
  type IpcRequest,
  type IpcResponse,
  type IpcTransport,
  type StandardSchemaV1,
} from '../src';

type TestHandler = (event: { sender: { id: number } }, request: IpcRequest) => Promise<IpcResponse>;

function createMemoryTransport() {
  const handlers = new Map<string, TestHandler>();
  const transport: IpcTransport = {
    handle: vi.fn((channel, handler) => {
      handlers.set(channel, handler as TestHandler);
    }),
    listenerCount: vi.fn(channel => (handlers.has(channel) ? 1 : 0)),
    removeHandler: vi.fn(channel => {
      handlers.delete(channel);
    }),
  };
  return { handlers, transport };
}

let ipcTransport = createMemoryTransport();

function schema<TOutput>(
  validate: (
    value: unknown,
  ) =>
    | { value: TOutput; issues?: undefined }
    | { issues: readonly { message: string; path?: readonly unknown[] }[] },
): StandardSchemaV1<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate,
    },
  };
}

function createPeer(id = 1) {
  return {
    id,
    sender: { id },
    onDispose: vi.fn(),
  };
}

async function invoke(channel: string, senderId: number, request: IpcRequest) {
  const handler = ipcTransport.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: { id: senderId } }, request);
}

beforeEach(() => {
  ipcTransport = createMemoryTransport();
});

describe('Ipcora core', () => {
  test('returns a successful handler response', async () => {
    const ipc = createIpcora<{ tenant: string }>({
      channel: 'test:success',
      transport: ipcTransport.transport,
    }).handler('ping', ({ tenant }) => ({ pong: tenant }));
    ipc.bind(createPeer(1), { context: { tenant: 'acme' } });

    await expect(invoke('test:success', 1, { id: '1', path: 'ping' })).resolves.toEqual({
      id: '1',
      ok: true,
      data: { pong: 'acme' },
    });
  });

  test('rejects calls from unbound peers', async () => {
    const ipc = createIpcora({
      channel: 'test:unbound',
      transport: ipcTransport.transport,
    }).handler('ping', () => 'pong');
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:unbound', 2, { id: '1', path: 'ping' })).resolves.toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'PEER_NOT_BOUND' },
    });
  });

  test('returns handler-not-found for unknown paths', async () => {
    const ipc = createIpcora({ channel: 'test:not-found', transport: ipcTransport.transport });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:not-found', 1, { id: '1', path: 'missing' })).resolves.toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'HANDLER_NOT_FOUND' },
    });
  });

  test('validates params and output with Standard Schema', async () => {
    const numberParams = schema<number>(value =>
      typeof value === 'number' ? { value } : { issues: [{ message: 'Expected number' }] },
    );
    const stringOutput = schema<string>(value =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string' }] },
    );

    const ipc = createIpcora({
      channel: 'test:schema',
      transport: ipcTransport.transport,
    }).handler('double', ({ params }) => String(params * 2), {
      params: numberParams,
      output: stringOutput,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:schema', 1, { id: '1', path: 'double', params: 2 })).resolves.toEqual(
      {
        id: '1',
        ok: true,
        data: '4',
      },
    );

    await expect(
      invoke('test:schema', 1, { id: '2', path: 'double', params: 'bad' }),
    ).resolves.toMatchObject({
      id: '2',
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  test('validates output schema failures', async () => {
    const stringOutput = schema<string>(value =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string' }] },
    );
    const ipc = createIpcora({
      channel: 'test:output-schema',
      transport: ipcTransport.transport,
    }).handler('bad', () => 1 as any, {
      output: stringOutput,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:output-schema', 1, { id: '1', path: 'bad' })).resolves.toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  test('joins group paths with handler paths', async () => {
    const ipc = createIpcora({ channel: 'test:group', transport: ipcTransport.transport }).group(
      'system',
      app => app.handler('restart', () => 'ok'),
    );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:group', 1, { id: '1', path: 'system.restart' })).resolves.toEqual({
      id: '1',
      ok: true,
      data: 'ok',
    });
  });

  test('runs handler-local lifecycle hooks in order', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: 'test:lifecycle', transport: ipcTransport.transport })
      .onRequest(() => {
        calls.push('global:onRequest');
      })
      .onTransform(({ params }) => {
        calls.push('global:onTransform');
        return params;
      })
      .onGuard(() => {
        calls.push('global:onGuard');
      })
      .onBeforeHandle(() => {
        calls.push('global:onBeforeHandle');
      })
      .onAfterHandle(({ output }) => {
        calls.push('global:onAfterHandle');
        return output;
      })
      .onMapResponse(({ response }) => {
        calls.push('global:onMapResponse');
        return response;
      })
      .onAfterResponse(() => {
        calls.push('global:onAfterResponse');
      })
      .handler(
        'run',
        () => {
          calls.push('handler');
          return 'ok';
        },
        {
          onRequest: () => {
            calls.push('local:onRequest');
          },
          onTransform: ({ params }) => {
            calls.push('local:onTransform');
            return params;
          },
          onGuard: () => {
            calls.push('local:onGuard');
          },
          onBeforeHandle: () => {
            calls.push('local:onBeforeHandle');
          },
          onAfterHandle: ({ output }) => {
            calls.push('local:onAfterHandle');
            return output;
          },
          onMapResponse: ({ response }) => {
            calls.push('local:onMapResponse');
            return response;
          },
          onAfterResponse: () => {
            calls.push('local:onAfterResponse');
          },
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await invoke('test:lifecycle', 1, { id: '1', path: 'run' });

    expect(calls).toEqual([
      'global:onRequest',
      'local:onRequest',
      'global:onTransform',
      'local:onTransform',
      'global:onGuard',
      'local:onGuard',
      'global:onBeforeHandle',
      'local:onBeforeHandle',
      'handler',
      'local:onAfterHandle',
      'global:onAfterHandle',
      'local:onMapResponse',
      'global:onMapResponse',
      'local:onAfterResponse',
      'global:onAfterResponse',
    ]);
  });

  test('injects state, decorators, derive, and resolve context extensions', async () => {
    const numberParams = schema<number>(value =>
      typeof value === 'number' ? { value } : { issues: [{ message: 'Expected number' }] },
    );
    const ipc = createIpcora({ channel: 'test:context', transport: ipcTransport.transport })
      .state('count', 1)
      .decorate('logger', { prefix: 'ipc' })
      .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))
      .resolve(({ params }) => ({ doubled: Number(params) * 2 }))
      .handler(
        'read',
        ({ store, logger, rawKind, doubled }) => {
          store.count += 1;
          return {
            count: store.count,
            prefix: logger.prefix,
            rawKind,
            doubled,
          };
        },
        { params: numberParams },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke('test:context', 1, { id: '1', path: 'read', params: 3 }),
    ).resolves.toMatchObject({
      ok: true,
      data: { count: 2, prefix: 'ipc', rawKind: 'number', doubled: 6 },
    });
    await expect(
      invoke('test:context', 1, { id: '2', path: 'read', params: 4 }),
    ).resolves.toMatchObject({
      ok: true,
      data: { count: 3, prefix: 'ipc', rawKind: 'number', doubled: 8 },
    });
  });

  test('expands macro options before handler-local hooks', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: 'test:macro', transport: ipcTransport.transport })
      .macro('auth', {
        onGuard({ option }) {
          calls.push(`macro:onGuard:${option}`);
          return { user: { role: option } };
        },
        onAfterHandle({ output }) {
          calls.push('macro:onAfterHandle');
          return output;
        },
      })
      .handler(
        'secure',
        ({ user }) => {
          calls.push(`handler:${user.role}`);
          return 'ok';
        },
        {
          auth: 'admin',
          onGuard() {
            calls.push('local:onGuard');
          },
          onAfterHandle({ output }) {
            calls.push('local:onAfterHandle');
            return output;
          },
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:macro', 1, { id: '1', path: 'secure' })).resolves.toMatchObject({
      ok: true,
      data: 'ok',
    });
    expect(calls).toEqual([
      'macro:onGuard:admin',
      'local:onGuard',
      'handler:admin',
      'local:onAfterHandle',
      'macro:onAfterHandle',
    ]);
  });

  test('allows onError to map custom responses', async () => {
    const ipc = createIpcora({ channel: 'test:error', transport: ipcTransport.transport }).handler(
      'explode',
      () => {
        throw createIpcError('NOPE', { message: 'Nope' });
      },
      {
        onError({ id, phase, cause }) {
          expect(phase).toBe('handler');
          expect(cause).toBeInstanceOf(Error);
          return { id, ok: true, data: 'handled' };
        },
      },
    );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:error', 1, { id: '1', path: 'explode' })).resolves.toEqual({
      id: '1',
      ok: true,
      data: 'handled',
    });
  });

  test('isolates onAfterResponse errors', async () => {
    const afterResponseError = vi.fn();
    const ipc = createIpcora({
      channel: 'test:after-response-error',
      transport: ipcTransport.transport,
      onAfterResponseError: afterResponseError,
    }).handler('ok', () => 'ok', {
      onAfterResponse() {
        throw new Error('log failed');
      },
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:after-response-error', 1, { id: '1', path: 'ok' })).resolves.toEqual({
      id: '1',
      ok: true,
      data: 'ok',
    });
    expect(afterResponseError).toHaveBeenCalledTimes(1);
    expect(afterResponseError).toHaveBeenCalledWith(expect.any(Error), 'ok');
  });
});
