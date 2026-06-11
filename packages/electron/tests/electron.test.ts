import { describe, expect, test, vi } from 'vitest';

import {
  bindBrowserWindow,
  createElectronAdapter,
  createBrowserWindowPeer,
  createElectronIpcora,
} from '../src';

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
    webContents: { id },
    once: vi.fn(),
  };
}

describe('@ipcora/electron', () => {
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
