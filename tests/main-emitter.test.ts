import { describe, expect, it, vi } from 'vite-plus/test';

import { TYPE_IPC_EMITTER_NAME } from '../src/constants';
import { defineEmitter } from '../src/main';
import { Type } from '../src/typebox';

// Mock electron
vi.mock('electron', () => {
  return {
    webContents: {
      getAllWebContents: vi.fn().mockReturnValue([{ send: vi.fn() }, { send: vi.fn() }]),
    },
  };
});

describe('defineEmitter', () => {
  it('should create a emitter and send data', () => {
    const createEmitter = defineEmitter('TestEmitter', { hello: Type.String() });
    const mockWindow = { webContents: { send: vi.fn() } };

    const emitter = createEmitter(mockWindow.webContents);
    emitter.hello('world');

    expect(mockWindow.webContents.send).toHaveBeenCalledWith(TYPE_IPC_EMITTER_NAME, {
      name: 'TestEmitter',
      method: 'hello',
      data: 'world',
    });
  });

  it('should send data correctly when validate=true', async () => {
    const createEmitter = defineEmitter(
      'TestEmitter',
      { hello: Type.String() },
      { validate: true },
    );
    const mockWindow = { webContents: { send: vi.fn() } } as any;
    const emitter = createEmitter(mockWindow.webContents);

    await emitter.hello('world');

    expect(mockWindow.webContents.send).toHaveBeenCalledWith(TYPE_IPC_EMITTER_NAME, {
      name: 'TestEmitter',
      method: 'hello',
      data: 'world',
    });
  });

  it('should throw error when data does not match schema', async () => {
    const createEmitter = defineEmitter(
      'TestEmitter',
      { hello: Type.String() },
      { validate: true },
    );
    const mockWindow = { webContents: { send: vi.fn() } } as any;
    const emitter = createEmitter(mockWindow);

    await expect(emitter.hello({} as any)).rejects.toThrow();
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });
});
