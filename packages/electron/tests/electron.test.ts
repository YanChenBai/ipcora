import type { BrowserWindow } from 'electron';
import type { StandardSchemaV1 } from 'ipcora';
import { defineEventSchema } from 'ipcora/event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, request: unknown) => unknown>(),
);

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
      electronHandlers.set(channel, handler);
    }),
    listenerCount: vi.fn((channel: string) => (electronHandlers.has(channel) ? 1 : 0)),
    removeHandler: vi.fn((channel: string) => {
      electronHandlers.delete(channel);
    }),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import {
  createElectronAdapter,
  createBrowserWindowPeer,
  createElectronIpcora,
  ELECTRON_IPCORA_CHANNEL,
} from '../src/main';
import type { BoundBrowserWindow, ElectronIpcora } from '../src/main';
import { createIpcoraClient } from '../src/renderer';

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function createIpcMain() {
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
      listenerCount: vi.fn((channel: string) => (handlers.has(channel) ? 1 : 0)),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
}

function createWindow(id = 1) {
  return {
    id,
    webContents: { id, send: vi.fn() },
    once: vi.fn(),
  };
}

function schema<TOutput>(): StandardSchemaV1<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value: value as TOutput }),
    },
  };
}

// -----------------------------------------------------------------------------
// Main process
// -----------------------------------------------------------------------------

describe('@ipcora/electron/main', () => {
  beforeEach(() => {
    electronHandlers.clear();
  });

  test('adapts ipcMain to an ipcora adapter', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const adapter = createElectronAdapter(ipcMain as never);

    adapter.handle('test', () => ({ data: 'ok' }));

    await expect(
      Promise.resolve(handlers.get('test')?.({ sender: { id: 1 } }, { id: '1' })),
    ).resolves.toEqual({
      data: 'ok',
    });
    expect(adapter.listenerCount('test')).toBe(1);
    const sender = { id: 1, send: vi.fn() };
    adapter.emit('test:event:update', sender as never, { title: 'Main Window' });
    expect(sender.send).toHaveBeenCalledWith('test:event:update', { title: 'Main Window' });

    adapter.removeHandler('test');
    expect(adapter.listenerCount('test')).toBe(0);
  });

  test('creates peers from BrowserWindow-like objects', () => {
    const window = createWindow(7);
    const peer = createBrowserWindowPeer(window as never);

    expect(peer.id).toBe(7);
    expect(peer.sender).toBe(window.webContents);

    const dispose = vi.fn();
    peer.onDispose?.(dispose);
    expect(window.once).toHaveBeenCalledWith('closed', dispose);
  });

  test('creates electron ipcora with the fixed channel', () => {
    const ipcora = createElectronIpcora();

    expect(ipcora.channel).toBe(ELECTRON_IPCORA_CHANNEL);
  });

  test('binds BrowserWindow peers to an electron ipcora instance by window id', async () => {
    const ipcora = createElectronIpcora<{ tenant: string }>().handler(
      'ping',
      ({ tenant }) => tenant,
    );

    (ipcora as unknown as ElectronIpcora<{ tenant: string }>).bind(
      createWindow(1) as unknown as BrowserWindow,
      {
        context: { tenant: 'acme' },
      },
    );

    await expect(
      electronHandlers.get(ELECTRON_IPCORA_CHANNEL)?.(
        { sender: { id: 1 } },
        { id: '1', path: 'ping' },
      ),
    ).resolves.toEqual({
      data: 'acme',
    });
  });

  test('returns a bound window emitter', async () => {
    const ipcora = createElectronIpcora().events(
      defineEventSchema({
        update: schema<{ title: string }>(),
      }),
    );
    const window = createWindow(5);
    const binding = (ipcora as unknown as ElectronIpcora).bind(
      window as unknown as BrowserWindow,
    ) as BoundBrowserWindow<any>;

    await binding.emit('update', { title: 'direct' });
    await binding.$emit.update({ title: 'proxy' });

    expect(binding.id).toBe(5);
    expect(window.webContents.send).toHaveBeenCalledWith(
      `${ELECTRON_IPCORA_CHANNEL}:event:update`,
      {
        title: 'direct',
      },
    );
    expect(window.webContents.send).toHaveBeenCalledWith(
      `${ELECTRON_IPCORA_CHANNEL}:event:update`,
      {
        title: 'proxy',
      },
    );

    binding.unbind();
    expect(window.once.mock.calls[0][0]).toBe('closed');
  });
});

// -----------------------------------------------------------------------------
// Preload
// -----------------------------------------------------------------------------

describe('@ipcora/electron/preload', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('exposes invoke and subscribe via contextBridge', async () => {
    const exposed: Record<string, unknown> = {};
    const ipcRendererOn = vi.fn();
    const ipcRendererRemove = vi.fn();
    const ipcRendererInvoke = vi.fn().mockResolvedValue({ data: 'ok' });

    vi.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: vi.fn((key: string, api: unknown) => {
          exposed[key] = api;
        }),
      },
      ipcRenderer: {
        invoke: ipcRendererInvoke,
        on: ipcRendererOn,
        removeListener: ipcRendererRemove,
      },
    }));

    // Dynamic import to pick up the mock
    const { exposeIpcoraBridge: bridgeFn } = await import('../src/preload');
    bridgeFn();

    const bridge = exposed.__IPCORA__ as {
      invoke: (req: unknown) => Promise<unknown>;
      subscribe: (ch: string, cb: (p: unknown) => void) => () => void;
    };

    // invoke
    const invokeResult = bridge.invoke({ id: 'r1', path: 'ping' });
    expect(ipcRendererInvoke).toHaveBeenCalledWith(ELECTRON_IPCORA_CHANNEL, {
      id: 'r1',
      path: 'ping',
    });
    await expect(invokeResult).resolves.toEqual({ data: 'ok' });

    // subscribe
    const listener = vi.fn();
    const unsub = bridge.subscribe('app:ipc:event:update', listener);
    expect(ipcRendererOn).toHaveBeenCalledWith('app:ipc:event:update', expect.any(Function));

    // Simulate event
    const handler = ipcRendererOn.mock.calls[0][1];
    handler({}, { title: 'hello' });
    expect(listener).toHaveBeenCalledWith({ title: 'hello' });

    // unsubscribe
    unsub();
    expect(ipcRendererRemove).toHaveBeenCalledWith('app:ipc:event:update', expect.any(Function));
  });
});

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------

describe('@ipcora/electron/renderer', () => {
  test('creates typed client backed by preload bridge', async () => {
    // Simulate preload bridge on window
    const invokeMock = vi.fn().mockResolvedValue({ data: 'pong' });
    const subscribeMock = vi.fn().mockReturnValue(() => {});

    vi.stubGlobal('window', {
      __IPCORA__: {
        invoke: invokeMock,
        subscribe: subscribeMock,
      },
    });

    // Minimal definition type (used only for type inference)
    const definition = {
      ping: (() => {}) as unknown as () => Promise<{ data: string; error: null }>,
    };

    const client = createIpcoraClient<typeof definition>();

    const result = await client.invoke.ping();
    expect(result).toEqual({ data: 'pong', error: null });
    expect(invokeMock).toHaveBeenCalledWith({
      id: expect.stringMatching(/^ping-/),
      path: 'ping',
      params: undefined,
      metadata: undefined,
    });
  });

  test('passes params through to bridge invoke', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: 'ok' });
    const subscribeMock = vi.fn().mockReturnValue(() => {});

    vi.stubGlobal('window', {
      __IPCORA__: {
        invoke: invokeMock,
        subscribe: subscribeMock,
      },
    });

    // Definition type with params
    const definition = {
      getUser: ((_params: { id: string }) => {}) as unknown as (params: {
        id: string;
      }) => Promise<{ data: { id: string }; error: null }>,
    };

    const client = createIpcoraClient<typeof definition>();

    await client.invoke.getUser({ id: '42' });
    expect(invokeMock).toHaveBeenCalledWith({
      id: expect.stringMatching(/^getUser-/),
      path: 'getUser',
      params: { id: '42' },
      metadata: undefined,
    });
  });

  test('throws when bridge is not exposed', () => {
    vi.stubGlobal('window', {});

    expect(() => createIpcoraClient()).toThrow(/Ipcora bridge not found at window\.__IPCORA__/);
  });

  test('passes static metadata from options', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ data: 'ok' });
    vi.stubGlobal('window', {
      __IPCORA__: {
        invoke: invokeMock,
        subscribe: vi.fn().mockReturnValue(() => {}),
      },
    });

    const definition = {
      ping: (() => {}) as unknown as () => Promise<{ data: string; error: null }>,
    };

    const client = createIpcoraClient<typeof definition>({
      metadata: { traceId: 't-123' },
    });

    await client.invoke.ping();
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { traceId: 't-123' },
      }),
    );
  });
});
