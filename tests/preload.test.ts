import { contextBridge, ipcRenderer } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { TYPE_IPC_EXPOSE_NAME, TYPE_IPC_HANDLER_NAME } from '../src/constants';
import { exposeTypeIpc } from '../src/preload';
import type { HandlerCallbackEvent, SenderCallbackEvent } from '../src/types';

vi.mock('electron', () => ({
  ipcRenderer: {
    on: vi.fn(),
    invoke: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
}));

vi.mock('../src/');

describe('exposeTypeIpc', () => {
  let exposedApi: {
    invoke: (data: HandlerCallbackEvent) => Promise<any>;
    message: (data: SenderCallbackEvent) => () => void;
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    exposeTypeIpc();

    // 获取暴露的 API
    const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
    exposedApi = calls[0][1];
  });

  it('should expose the API with invoke and message methods', () => {
    exposeTypeIpc();
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      TYPE_IPC_EXPOSE_NAME,
      expect.objectContaining({
        invoke: expect.any(Function),
        message: expect.any(Function),
      }),
    );
  });

  it('should forward invoke calls to ipcRenderer.invoke', async () => {
    const testData: HandlerCallbackEvent = {
      name: 'testHandler',
      method: 'testMethod',
      data: { test: 'data' },
    };

    vi.mocked(ipcRenderer.invoke).mockResolvedValue('test result');

    const result = await exposedApi.invoke(testData);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(TYPE_IPC_HANDLER_NAME, testData);
    expect(result).toBe('test result');
  });

  it('should call the callback when an "on" event is received', () => {
    const callback = vi.fn();

    exposedApi.message({
      name: 'chat',
      method: 'onMessage',
      callback,
    });

    const ipcCalls = vi.mocked(ipcRenderer.on).mock.calls;
    const [, ipcCallback] = ipcCalls[0];

    const fakeEvent = {
      name: 'chat',
      method: 'Message',
      data: { text: 'hello' },
    };

    ipcCallback({} as any, fakeEvent);

    expect(callback).toHaveBeenCalledWith(fakeEvent.data);
  });

  it('should stop calling the callback after off() is called', () => {
    const callback = vi.fn();

    const off = exposedApi.message({
      name: 'chat',
      method: 'onMessage',
      callback,
    });

    const ipcCalls = vi.mocked(ipcRenderer.on).mock.calls;
    const [, ipcCallback] = ipcCalls[0];

    const fakeEvent = {
      name: 'chat',
      method: 'Message',
      data: { text: 'hello' },
    };

    ipcCallback({} as any, fakeEvent);
    ipcCallback({} as any, fakeEvent);
    off();
    ipcCallback({} as any, fakeEvent);

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('should call the callback only once for a "once" event', () => {
    const callback = vi.fn();

    exposedApi.message({
      name: 'chat',
      method: 'onceMessage',
      callback,
    });

    const ipcCalls = vi.mocked(ipcRenderer.on).mock.calls;
    const [, ipcCallback] = ipcCalls[0];

    const fakeEvent = {
      name: 'chat',
      method: 'Message',
      data: { text: 'hello' },
    };

    ipcCallback({} as any, fakeEvent);
    ipcCallback({} as any, fakeEvent);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
