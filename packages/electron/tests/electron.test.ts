import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  bindBrowserWindow,
  createElectronAdapter,
  createBrowserWindowPeer,
  createElectronIpcora,
} from '../src/main';
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
    webContents: { id, send: vi.fn() },
    once: vi.fn(),
  };
}

// -----------------------------------------------------------------------------
// Main process
// -----------------------------------------------------------------------------

describe('@ipcora/electron/main', () => {
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

  test('binds BrowserWindow peers to an ipcora instance', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const ipcora = createElectronIpcora<{ tenant: string }>({
      channel: 'test:electron',
      ipcMain: ipcMain as never,
    }).handler('ping', ({ tenant }) => tenant);

    bindBrowserWindow(ipcora, createWindow(1) as never, { context: { tenant: 'acme' } });

    await expect(
      handlers.get('test:electron')?.({ sender: { id: 1 } }, { id: '1', path: 'ping' }),
    ).resolves.toEqual({
      data: 'acme',
    });
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
        exposeInMainWorld: vi.fn((apiKey: string, api: unknown) => {
          exposed[apiKey] = api;
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
    bridgeFn({ channel: 'app:ipc' });

    const bridge = exposed.__IPCORA__ as {
      invoke: (req: unknown) => Promise<unknown>;
      subscribe: (ch: string, cb: (p: unknown) => void) => () => void;
    };

    // invoke
    const invokeResult = bridge.invoke({ id: 'r1', path: 'ping' });
    expect(ipcRendererInvoke).toHaveBeenCalledWith('app:ipc', { id: 'r1', path: 'ping' });
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

  test('supports custom apiKey', async () => {
    const exposed: Record<string, unknown> = {};
    vi.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: vi.fn((apiKey: string, api: unknown) => {
          exposed[apiKey] = api;
        }),
      },
      ipcRenderer: {
        invoke: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
    }));

    const { exposeIpcoraBridge: bridgeFn } = await import('../src/preload');
    bridgeFn({ channel: 'my-app', apiKey: 'MY_API' });

    expect(exposed).toHaveProperty('MY_API');
    expect(exposed.__IPCORA__).toBeUndefined();
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

    // Minimal definition object (used only for type inference)
    const definition = {
      ping: (() => {}) as unknown as () => Promise<{ data: string; error: null }>,
    };

    const client = createIpcoraClient<typeof definition>(definition);

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

    // Definition with params (arity > 0)
    const definition = {
      getUser: ((_params: { id: string }) => {}) as unknown as (params: {
        id: string;
      }) => Promise<{ data: { id: string }; error: null }>,
    };

    const client = createIpcoraClient<typeof definition>(definition);

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

    const definition = { test: () => {} };

    expect(() => createIpcoraClient(definition)).toThrow(
      /Ipcora bridge not found at window\.__IPCORA__/,
    );
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

    const client = createIpcoraClient<typeof definition>(definition, {
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
