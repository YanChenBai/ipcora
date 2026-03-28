import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { TYPE_IPC_HANDLER_NAME } from '../src/constants';
import type { HandlerListenerEvent } from '../src/main';
import { defineHandler, registerHandlers } from '../src/main';
import { Type } from '../src/typebox';

// Mock electron
vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(),
    },
    app: {
      whenReady: vi.fn().mockResolvedValue(true),
    },
    BrowserWindow: {
      fromId: vi.fn().mockReturnValue({ id: 1 }),
    },
  };
});

describe('defineHandler', () => {
  it('should create a handler and execute correctly', async () => {
    const handlerCallback = defineHandler('math', {
      add: (_event, data: { a: number; b: number }) => data.a + data.b,
    });

    const mockEvent: any = { sender: { id: 1 } };
    const result = await handlerCallback(mockEvent, {
      name: 'math',
      method: 'add',
      data: { a: 1, b: 2 },
    });

    expect(result).toBe(3);
  });

  it('should throw error if handler not found', async () => {
    const handlerCallback = defineHandler('math', {
      add: () => 1,
    });

    const mockEvent: any = { sender: { id: 1 } };
    await expect(
      handlerCallback(mockEvent, {
        name: 'math',
        method: 'sub',
        data: {},
      }),
    ).rejects.toThrow(/Handler sub not found/);
  });

  it('should throw error if handler return error', async () => {});

  it('should parse and validate data correctly', async () => {
    const schema = {
      add: {
        data: Type.Object({ a: Type.Number(), b: Type.Number() }),
        return: Type.Number(),
      },
    };

    const handlerFn = vi.fn(
      (event: HandlerListenerEvent, data: { a: number; b: number }) => data.a + data.b,
    );

    const handlerCallback = defineHandler('math', { add: handlerFn as any }, schema, {
      validate: true,
    });

    const mockEvent: any = { sender: { id: 1 } };

    const result = await handlerCallback(mockEvent, {
      name: 'math',
      method: 'add',
      data: { a: 2, b: 3 },
    });

    expect(result).toBe(5);
    expect(handlerFn).toHaveBeenCalledWith(expect.any(Object), { a: 2, b: 3 });
  });

  it('should throw error if data does not match schema', async () => {
    const schema = {
      add: {
        data: Type.Object({ a: Type.Number(), b: Type.Number() }),
        return: Type.Number(),
      },
    };

    const handlerFn = vi.fn();

    const handlerCallback = defineHandler('math', { add: handlerFn }, schema, { validate: true });

    const mockEvent: any = { sender: { id: 1 } };

    await expect(
      handlerCallback(mockEvent, {
        name: 'math',
        method: 'add',
        data: { a: 1, b: 'wrong type' }, // b is a number
      }),
    ).rejects.toThrow(); // Value.Parse will throw an error

    expect(handlerFn).not.toHaveBeenCalled();
  });
});

describe('registerHandlers', () => {
  let ipcMain: any;

  beforeEach(async () => {
    vi.resetModules();
    ipcMain = (await import('electron')).ipcMain;
    vi.clearAllMocks();
  });

  it('should register handlers and call the right one', async () => {
    const mathHandler = defineHandler('math', {
      add: (_event, data: { a: number; b: number }) => data.a + data.b,
    });

    const reg = registerHandlers(mathHandler);

    reg.start();

    // Mock ipcMain.handle call
    const handleFn = (ipcMain.handle as any).mock.calls[0][1];

    const mockEvent: any = { sender: { id: 1 } };
    const res = await handleFn(mockEvent, { name: 'math', method: 'add', data: { a: 2, b: 5 } });

    expect(res.error).toBe(null);
    expect(await res.data).toBe(7);
  });

  it('should return error if handler name not found', async () => {
    const mathHandler = defineHandler('math', {
      add: (_event, data: { a: number; b: number }) => data.a + data.b,
    });

    const reg = registerHandlers(mathHandler);
    reg.start();

    const handleFn = (ipcMain.handle as any).mock.calls[0][1];

    const mockEvent: any = { sender: { id: 1 } };
    const res = await handleFn(mockEvent, { name: 'wrong', method: 'add', data: { a: 2, b: 5 } });

    expect(res.error).toBeInstanceOf(Error);
    expect(res.data).toBe(null);
  });

  it('should support add and del handlers dynamically', async () => {
    const mathHandler = defineHandler('math', {
      add: (_event, data: { a: number; b: number }) => data.a + data.b,
    });

    const reg = registerHandlers();
    reg.add(mathHandler);
    reg.start();

    const handleFn = (ipcMain.handle as any).mock.calls[0][1];

    const mockEvent: any = { sender: { id: 1 } };
    const res1 = await handleFn(mockEvent, { name: 'math', method: 'add', data: { a: 1, b: 1 } });

    expect(await res1.data).toBe(2);

    reg.del(mathHandler);

    const res2 = await handleFn(mockEvent, { name: 'math', method: 'add', data: { a: 1, b: 1 } });
    expect(res2.error).toBeInstanceOf(Error);
    expect(res2.data).toBe(null);
  });

  it('appWhenReadyStart should wait for app.whenReady', async () => {
    const mathHandler = defineHandler('math', {
      add: (_event, data: { a: number; b: number }) => data.a + data.b,
    });

    const reg = registerHandlers(mathHandler);
    await reg.appWhenReadyStart();

    expect(ipcMain.handle).toHaveBeenCalledWith(TYPE_IPC_HANDLER_NAME, expect.any(Function));
  });
});
