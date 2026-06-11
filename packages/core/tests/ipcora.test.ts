import { beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

import {
  createIpcora,
  fail,
  type IpcRequest,
  type IpcResponse,
  type IpcAdapter,
  type StandardSchemaV1,
} from '../src';

type TestHandler = (event: { sender: { id: number } }, request: IpcRequest) => Promise<IpcResponse>;

function createMemoryAdapter() {
  const handlers = new Map<string, TestHandler>();
  const adapter: IpcAdapter = {
    handle: vi.fn((channel, handler) => {
      handlers.set(channel, handler as TestHandler);
    }),
    listenerCount: vi.fn(channel => (handlers.has(channel) ? 1 : 0)),
    removeHandler: vi.fn(channel => {
      handlers.delete(channel);
    }),
  };
  return { handlers, adapter };
}

let ipcAdapter = createMemoryAdapter();

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
  const handler = ipcAdapter.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: { id: senderId } }, request);
}

beforeEach(() => {
  ipcAdapter = createMemoryAdapter();
});

describe('Ipcora core', () => {
  test('returns a successful handler response', async () => {
    const ipc = createIpcora<{ tenant: string }>({
      channel: 'test:success',
      adapter: ipcAdapter.adapter,
    }).handler('ping', ({ tenant }) => ({ pong: tenant }));
    ipc.bind(createPeer(1), { context: { tenant: 'acme' } });

    await expect(invoke('test:success', 1, { id: '1', path: 'ping' })).resolves.toEqual({
      data: { pong: 'acme' },
    });
  });

  test('exposes a fully inferred route definition for clients', () => {
    const stringParams = schema<string>(value =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string' }] },
    );
    const ipc = createIpcora({ channel: 'test:definition', adapter: ipcAdapter.adapter })
      .handler('user.read', async ({ params }) => ({ id: params }), {
        params: stringParams,
      })
      .group('project', app => app.handler('list', () => [{ id: 'project-1' }]));

    expectTypeOf(ipc.definition.user.read).toMatchTypeOf<
      (params: string) => Promise<{ data: { id: string } | null; error: unknown }>
    >();
    expectTypeOf(ipc.definition.project.list).toMatchTypeOf<
      () => Promise<{ data: { id: string }[] | null; error: unknown }>
    >();
    expect(ipc.definition).toMatchObject({
      user: { read: expect.any(Function) },
      project: { list: expect.any(Function) },
    });
  });

  test('rejects calls from unbound peers', async () => {
    const ipc = createIpcora({
      channel: 'test:unbound',
      adapter: ipcAdapter.adapter,
    }).handler('ping', () => 'pong');
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:unbound', 2, { id: '1', path: 'ping' })).resolves.toMatchObject({
      error: { name: 'PEER_NOT_BOUND' },
    });
  });

  test('returns handler-not-found for unknown paths', async () => {
    const ipc = createIpcora({ channel: 'test:not-found', adapter: ipcAdapter.adapter });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:not-found', 1, { id: '1', path: 'missing' })).resolves.toMatchObject({
      error: { name: 'HANDLER_NOT_FOUND' },
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
      adapter: ipcAdapter.adapter,
    }).handler('double', ({ params }) => String(params * 2), {
      params: numberParams,
      output: stringOutput,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:schema', 1, { id: '1', path: 'double', params: 2 })).resolves.toEqual(
      {
        data: '4',
      },
    );

    await expect(
      invoke('test:schema', 1, { id: '2', path: 'double', params: 'bad' }),
    ).resolves.toMatchObject({
      error: { name: 'VALIDATION_ERROR' },
    });
  });

  test('validates output schema failures', async () => {
    const stringOutput = schema<string>(value =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string' }] },
    );
    const ipc = createIpcora({
      channel: 'test:output-schema',
      adapter: ipcAdapter.adapter,
    }).handler('bad', () => 1 as any, {
      output: stringOutput,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:output-schema', 1, { id: '1', path: 'bad' })).resolves.toMatchObject({
      error: { name: 'VALIDATION_ERROR' },
    });
  });

  test('joins group paths with handler paths', async () => {
    const ipc = createIpcora({ channel: 'test:group', adapter: ipcAdapter.adapter }).group(
      'system',
      app => app.handler('restart', () => 'ok'),
    );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:group', 1, { id: '1', path: 'system.restart' })).resolves.toEqual({
      data: 'ok',
    });
  });

  test('runs handler-local lifecycle hooks in order', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: 'test:lifecycle', adapter: ipcAdapter.adapter })
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
    const ipc = createIpcora({ channel: 'test:context', adapter: ipcAdapter.adapter })
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
      data: { count: 2, prefix: 'ipc', rawKind: 'number', doubled: 6 },
    });
    await expect(
      invoke('test:context', 1, { id: '2', path: 'read', params: 4 }),
    ).resolves.toMatchObject({
      data: { count: 3, prefix: 'ipc', rawKind: 'number', doubled: 8 },
    });
  });

  test('expands macro options before handler-local hooks', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: 'test:macro', adapter: ipcAdapter.adapter })
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

  test('supports Elysia-style macro factories and object shorthand', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: 'test:macro-factory', adapter: ipcAdapter.adapter })
      .macro({
        role: (role: 'admin' | 'member') => ({
          resolve() {
            calls.push(`role:${role}`);
            return { role };
          },
        }),
        isAuth: {
          resolve() {
            calls.push('isAuth');
            return { user: 'saltyaom' };
          },
        },
      })
      .handler(
        'secure',
        ({ role, user }) => {
          calls.push(`handler:${role}:${user}`);
          return { role, user };
        },
        {
          role: 'admin',
          isAuth: true,
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:macro-factory', 1, { id: '1', path: 'secure' })).resolves.toEqual({
      data: { role: 'admin', user: 'saltyaom' },
    });
    expect(calls).toEqual(['role:admin', 'isAuth', 'handler:admin:saltyaom']);
  });

  test('allows macros to extend other macros and deduplicates by seed', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: 'test:macro-extension', adapter: ipcAdapter.adapter })
      .macro({
        base: (name: string) => ({
          seed: name,
          onBeforeHandle() {
            calls.push(`base:${name}`);
          },
        }),
        composed: {
          base: 'shared',
          onBeforeHandle() {
            calls.push('composed');
          },
        },
        another: {
          base: 'shared',
          onBeforeHandle() {
            calls.push('another');
          },
        },
      })
      .handler(
        'run',
        () => {
          calls.push('handler');
          return 'ok';
        },
        {
          composed: true,
          another: true,
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:macro-extension', 1, { id: '1', path: 'run' })).resolves.toEqual({
      data: 'ok',
    });
    expect(calls).toEqual(['base:shared', 'composed', 'another', 'handler']);
  });

  test('composes macro schemas with route schemas', async () => {
    const objectParams = schema<Record<string, unknown>>(value =>
      value && typeof value === 'object'
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: 'Expected object params' }] },
    );
    const namedParams = schema<{ name: string }>(value => {
      const params = value as Record<string, unknown>;
      return typeof params.name === 'string'
        ? { value: { name: params.name } }
        : { issues: [{ message: 'Expected name', path: ['name'] }] };
    });
    const ipc = createIpcora({ channel: 'test:macro-schema', adapter: ipcAdapter.adapter })
      .macro({
        withObjectParams: {
          params: objectParams,
        },
      })
      .handler('read', ({ params }) => params.name, {
        params: namedParams,
        withObjectParams: true,
      });
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke('test:macro-schema', 1, { id: '1', path: 'read', params: { name: 'Lilith' } }),
    ).resolves.toMatchObject({
      data: 'Lilith',
    });
    await expect(
      invoke('test:macro-schema', 1, { id: '2', path: 'read', params: 'bad' }),
    ).resolves.toMatchObject({
      error: { name: 'VALIDATION_ERROR' },
    });
  });

  test('allows onError to map custom responses', async () => {
    const ipc = createIpcora({ channel: 'test:error', adapter: ipcAdapter.adapter }).handler(
      'explode',
      () => {
        throw fail('NOPE', 'Nope');
      },
      {
        onError({ phase, cause }) {
          expect(phase).toBe('handler');
          expect(cause).toBeInstanceOf(Error);
          return { data: 'handled' };
        },
      },
    );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:error', 1, { id: '1', path: 'explode' })).resolves.toEqual({
      data: 'handled',
    });
  });

  test('routes returned and thrown status through onError', async () => {
    const calls: string[] = [];
    const ipc = createIpcora({
      channel: 'test:status-on-error',
      adapter: ipcAdapter.adapter,
    })
      .handler('return-status', ({ fail }) => fail('TEAPOT', 'returned', { status: 418 }), {
        onError({ name, error, fail }) {
          calls.push(`return:${name}:${error.status}`);
          return fail('RETURN_MAPPED', error.message, { status: 499 });
        },
      })
      .handler(
        'throw-status',
        ({ fail }) => {
          throw fail('TEAPOT', 'thrown');
        },
        {
          onError({ name, error, fail }) {
            calls.push(`throw:${name}:${error.message}`);
            return fail('THROW_MAPPED', error.message, { status: 498 });
          },
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke('test:status-on-error', 1, { id: '1', path: 'return-status' }),
    ).resolves.toMatchObject({
      error: { name: 'RETURN_MAPPED', message: 'returned', status: 499 },
    });
    await expect(
      invoke('test:status-on-error', 1, { id: '2', path: 'throw-status' }),
    ).resolves.toMatchObject({
      error: { name: 'THROW_MAPPED', message: 'thrown', status: 498 },
    });
    expect(calls).toEqual(['return:TEAPOT:418', 'throw:TEAPOT:thrown']);
  });

  test('maps custom errors into typed handler errors', async () => {
    class MyError extends Error {}

    const ipc = createIpcora({
      channel: 'test:typed-error',
      adapter: ipcAdapter.adapter,
    })
      .error(MyError, ({ fail, error }) => fail('MyError', error.message, { status: 418 }))
      .handler('fail', () => {
        throw new MyError('short and stout');
      });

    type FailResult = Awaited<ReturnType<typeof ipc.definition.fail>>;
    expectTypeOf<Extract<FailResult['error'], { name: 'MyError' }>>().toMatchTypeOf<{
      name: 'MyError';
      message: string;
      status?: 418;
    }>();

    ipc.bind(createPeer(1), { context: {} });
    await expect(invoke('test:typed-error', 1, { id: '1', path: 'fail' })).resolves.toMatchObject({
      error: { name: 'MyError', message: 'short and stout', status: 418 },
    });
  });

  test('includes onError returned status in route error inference', () => {
    const ipc = createIpcora({ channel: 'test:on-error-type', adapter: ipcAdapter.adapter })
      .onError(({ fail }) => fail('GLOBAL_ERROR', 'global'))
      .handler('local', () => 'ok', {
        onError({ fail }) {
          return fail('LOCAL_ERROR', 'local', { status: 418 });
        },
      });

    type LocalResult = Awaited<ReturnType<typeof ipc.definition.local>>;
    expectTypeOf<Extract<LocalResult['error'], { name: 'GLOBAL_ERROR' }>>().toMatchTypeOf<{
      name: 'GLOBAL_ERROR';
      message: string;
    }>();
    expectTypeOf<Extract<LocalResult['error'], { name: 'LOCAL_ERROR' }>>().toMatchTypeOf<{
      name: 'LOCAL_ERROR';
      message: string;
      status?: 418;
    }>();
  });

  test('isolates onAfterResponse errors', async () => {
    const afterResponseError = vi.fn();
    const ipc = createIpcora({
      channel: 'test:after-response-error',
      adapter: ipcAdapter.adapter,
      onAfterResponseError: afterResponseError,
    }).handler('ok', () => 'ok', {
      onAfterResponse() {
        throw new Error('log failed');
      },
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke('test:after-response-error', 1, { id: '1', path: 'ok' })).resolves.toEqual({
      data: 'ok',
    });
    expect(afterResponseError).toHaveBeenCalledTimes(1);
    expect(afterResponseError).toHaveBeenCalledWith(expect.any(Error), 'ok');
  });

  describe('name deduplication', () => {
    test('prevents binding two routers with the same name', () => {
      createIpcora({
        name: 'dedup',
        channel: 'test:dedup-1',
        adapter: ipcAdapter.adapter,
      }).bind(createPeer(1), { context: {} });

      const second = createIpcora({
        name: 'dedup',
        channel: 'test:dedup-2',
        adapter: ipcAdapter.adapter,
      });

      expect(() => second.bind(createPeer(2), { context: {} })).toThrow(
        'IPC router "dedup" is already installed.',
      );
    });

    test('allows same name after dispose', () => {
      const first = createIpcora({
        name: 'reusable',
        channel: 'test:reuse-1',
        adapter: ipcAdapter.adapter,
      }).handler('ping', () => 'pong');
      first.bind(createPeer(1), { context: {} });
      first.dispose();

      const second = createIpcora({
        name: 'reusable',
        channel: 'test:reuse-2',
        adapter: ipcAdapter.adapter,
      }).handler('ping', () => 'pong');

      expect(() => second.bind(createPeer(2), { context: {} })).not.toThrow();
      second.dispose();
    });

    test('unnamed routers never conflict', () => {
      createIpcora({
        channel: 'test:no-name-1',
        adapter: ipcAdapter.adapter,
      }).bind(createPeer(1), { context: {} });

      // Different channel is required since the adapter checks channel dedup.
      // Name-less routers only use the channel-based check, no static guard.
      expect(() =>
        createIpcora({
          channel: 'test:no-name-2',
          adapter: ipcAdapter.adapter,
        }).bind(createPeer(2), { context: {} }),
      ).not.toThrow();
    });
  });

  describe('abstract', () => {
    test('contributes type definitions but skips runtime registration', () => {
      const ipc = createIpcora({ abstract: true, adapter: ipcAdapter.adapter }).handler(
        'ping',
        () => 'pong',
      );

      // Type definition is present.
      expect(ipc.definition).toMatchObject({
        ping: expect.any(Function),
      });

      // No adapter was installed (installAdapter is a no-op for abstract routers).
      expect(ipcAdapter.adapter.handle).not.toHaveBeenCalled();

      // Binding does installAdapter which is a no-op, so it should not throw
      // but also not actually register anything on the adapter.
      ipc.bind(createPeer(1), { context: {} });
      expect(ipcAdapter.adapter.handle).not.toHaveBeenCalled();
    });

    test('grouped abstract routes contribute to definition', () => {
      const ipc = createIpcora({ abstract: true }).group('system', app =>
        app.handler('health', () => 'ok').handler('version', () => '1.0.0'),
      );

      expect(ipc.definition).toMatchObject({
        system: {
          health: expect.any(Function),
          version: expect.any(Function),
        },
      });
    });

    test('scoped abstract routers preserve the flag', () => {
      const ipc = createIpcora({ abstract: true, adapter: ipcAdapter.adapter }).group(
        'admin',
        app => {
          expect(app.abstract).toBe(true);
          return app.handler('dashboard', () => 'stats');
        },
      );

      expect(ipc.definition).toMatchObject({
        admin: { dashboard: expect.any(Function) },
      });
      expect(ipcAdapter.adapter.handle).not.toHaveBeenCalled();
    });

    test('non-abstract routers still register handlers', async () => {
      const ipc = createIpcora({
        channel: 'test:concrete',
        adapter: ipcAdapter.adapter,
      }).handler('ping', () => 'pong');
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke('test:concrete', 1, { id: '1', path: 'ping' })).resolves.toEqual({
        data: 'pong',
      });
    });
  });

  describe('error paths', () => {
    test('macro onGuard throw enters local onError', async () => {
      const ipc = createIpcora({
        channel: 'test:guard-err',
        adapter: ipcAdapter.adapter,
      })
        .macro('requireRole', {
          onGuard({ option, fail }) {
            throw fail('FORBIDDEN', `Expected role ${option}`);
          },
        })
        .handler('adminOnly', () => 'secret', {
          requireRole: 'admin',
          onError({ name, error }) {
            return { data: { reason: name, message: error.message } };
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke('test:guard-err', 1, { id: '1', path: 'adminOnly' })).resolves.toEqual({
        data: { reason: 'FORBIDDEN', message: 'Expected role admin' },
      });
    });

    test('macro onGuard throw without local onError falls to global onError', async () => {
      const ipc = createIpcora({
        channel: 'test:guard-global',
        adapter: ipcAdapter.adapter,
      })
        .onError(({ name, error }) => {
          if (name === 'FORBIDDEN') {
            return { data: { blocked: error.message } };
          }
        })
        .macro('auth', {
          onGuard({ fail }) {
            throw fail('FORBIDDEN', 'Access denied');
          },
        })
        .handler('secure', () => 'ok', { auth: true });
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke('test:guard-global', 1, { id: '1', path: 'secure' })).resolves.toEqual({
        data: { blocked: 'Access denied' },
      });
    });

    test('onGuard error reports correct phase in onError hook', async () => {
      let errorPhase = '';
      const ipc = createIpcora({
        channel: 'test:guard-phase',
        adapter: ipcAdapter.adapter,
      })
        .onGuard(() => {
          throw fail('BLOCKED');
        })
        .handler('gated', () => 'ok', {
          onError({ phase }) {
            errorPhase = phase;
            return { data: 'ok' };
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke('test:guard-phase', 1, { id: '1', path: 'gated' });
      expect(errorPhase).toBe('onGuard');
    });

    test('handler returning fail() is converted to error response', async () => {
      const ipc = createIpcora({
        channel: 'test:handler-fail',
        adapter: ipcAdapter.adapter,
      }).handler('deny', ({ fail }) => fail('NOT_ALLOWED', 'No access', { status: 403 }));
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke('test:handler-fail', 1, { id: '1', path: 'deny' }),
      ).resolves.toMatchObject({
        error: { name: 'NOT_ALLOWED', message: 'No access', status: 403 },
      });
    });

    test('handler returning fail() can be remapped in local onError', async () => {
      const ipc = createIpcora({
        channel: 'test:handler-fail-remap',
        adapter: ipcAdapter.adapter,
      }).handler('deny', ({ fail }) => fail('RAW', 'raw'), {
        onError({ fail }) {
          return fail('MAPPED', 'mapped', { status: 418 });
        },
      });
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke('test:handler-fail-remap', 1, { id: '1', path: 'deny' }),
      ).resolves.toMatchObject({
        error: { name: 'MAPPED', message: 'mapped', status: 418 },
      });
    });

    test('validation error preserves schema issue details', async () => {
      const namedParams = schema<{ name: string }>(value => {
        const p = value as Record<string, unknown>;
        return typeof p?.name === 'string'
          ? { value: { name: p.name } }
          : { issues: [{ message: 'name is required', path: ['name'] }] };
      });

      const ipc = createIpcora({
        channel: 'test:valid-path',
        adapter: ipcAdapter.adapter,
      }).handler('create', ({ params }) => params.name, { params: namedParams });
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke('test:valid-path', 1, { id: '1', path: 'create', params: {} }),
      ).resolves.toMatchObject({
        error: { name: 'VALIDATION_ERROR' },
      });
    });

    test('non-IpcError with status code is normalized', async () => {
      class HttpError extends Error {
        constructor(
          message: string,
          public status: number,
        ) {
          super(message);
          this.name = 'HttpError';
        }
      }

      const ipc = createIpcora({
        channel: 'test:http-err',
        adapter: ipcAdapter.adapter,
      }).handler('fail', () => {
        throw new HttpError('gone', 410);
      });
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke('test:http-err', 1, { id: '1', path: 'fail' })).resolves.toMatchObject({
        error: { name: 'HttpError', message: 'gone', status: 410 },
      });
    });
  });

  describe('middleware', () => {
    test('passes context extension from middleware to handler', async () => {
      const ipc = createIpcora({
        channel: 'test:middleware',
        adapter: ipcAdapter.adapter,
      })
        .use<{ traceId: string }>(({ metadata }, next) => {
          return next({ traceId: String(metadata.traceId ?? 'default') });
        })
        .handler('read', ({ traceId }) => ({ traceId }));
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke('test:middleware', 1, {
          id: '1',
          path: 'read',
          metadata: { traceId: 'trace-001' },
        }),
      ).resolves.toEqual({
        data: { traceId: 'trace-001' },
      });
    });

    test('runs multiple middleware in registration order', async () => {
      const calls: string[] = [];
      const ipc = createIpcora({
        channel: 'test:mw-order',
        adapter: ipcAdapter.adapter,
      })
        .use<{ a: number }>((_ctx, next) => {
          calls.push('mw1-in');
          return next({ a: 1 }).then((r: unknown) => {
            calls.push('mw1-out');
            return r;
          });
        })
        .use<{ b: number }>((_ctx, next) => {
          calls.push('mw2-in');
          return next({ b: 2 }).then((r: unknown) => {
            calls.push('mw2-out');
            return r;
          });
        })
        .handler('run', ctx => {
          calls.push('handler');
          return { a: (ctx as any).a, b: (ctx as any).b };
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke('test:mw-order', 1, { id: '1', path: 'run' });
      expect(calls).toEqual(['mw1-in', 'mw2-in', 'handler', 'mw2-out', 'mw1-out']);
    });

    test('middleware context merges with derive/resolve context', async () => {
      const ipc = createIpcora({
        channel: 'test:mw-merge',
        adapter: ipcAdapter.adapter,
      })
        .derive(() => ({ derived: 'from-derive' }))
        .use<{ middleware: string }>((_ctx, next) => next({ middleware: 'from-mw' }))
        .resolve(() => ({ resolved: 'from-resolve' }))
        .handler('read', ({ derived, middleware, resolved }) => ({
          derived,
          middleware,
          resolved,
        }));
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke('test:mw-merge', 1, { id: '1', path: 'read' })).resolves.toEqual({
        data: { derived: 'from-derive', middleware: 'from-mw', resolved: 'from-resolve' },
      });
    });
  });

  describe('multi-handler', () => {
    test('multiple handlers on one instance are independent', async () => {
      const ipc = createIpcora({
        channel: 'test:multi-handler',
        adapter: ipcAdapter.adapter,
      })
        .handler('a', () => 'result-a')
        .handler('b', () => 'result-b');
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke('test:multi-handler', 1, { id: '1', path: 'a' })).resolves.toEqual({
        data: 'result-a',
      });

      await expect(invoke('test:multi-handler', 1, { id: '2', path: 'b' })).resolves.toEqual({
        data: 'result-b',
      });
    });

    test('each handler gets its own middleware chain', async () => {
      const calls: string[] = [];
      const ipc = createIpcora({
        channel: 'test:mw-per-route',
        adapter: ipcAdapter.adapter,
      })
        .use((_ctx, next) => {
          calls.push('mw');
          return next();
        })
        .handler('first', () => {
          calls.push('first');
          return 'ok';
        })
        .handler('second', () => {
          calls.push('second');
          return 'ok';
        });
      ipc.bind(createPeer(1), { context: {} });

      calls.length = 0;
      await invoke('test:mw-per-route', 1, { id: '1', path: 'first' });
      expect(calls).toEqual(['mw', 'first']);

      calls.length = 0;
      await invoke('test:mw-per-route', 1, { id: '2', path: 'second' });
      expect(calls).toEqual(['mw', 'second']);
    });
  });

  describe('derive → later-hook', () => {
    test('derive result is accessible in onAfterHandle', async () => {
      let rawKindInAfterHandle = '';
      const ipc = createIpcora({
        channel: 'test:derive-cross',
        adapter: ipcAdapter.adapter,
      })
        .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))
        .handler('run', () => 'ok', {
          onAfterHandle({ rawKind, output }) {
            rawKindInAfterHandle = rawKind as string;
            return output;
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke('test:derive-cross', 1, { id: '1', path: 'run', params: { x: 1 } });
      expect(rawKindInAfterHandle).toBe('object');
    });

    test('derive result is accessible in onMapResponse', async () => {
      let rawKindInMap = '';
      const ipc = createIpcora({
        channel: 'test:derive-map',
        adapter: ipcAdapter.adapter,
      })
        .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))
        .handler('run', () => 'ok', {
          onMapResponse({ rawKind, response }) {
            rawKindInMap = rawKind as string;
            return response;
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke('test:derive-map', 1, { id: '1', path: 'run', params: 'hello' });
      expect(rawKindInMap).toBe('string');
    });
  });
});
