import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { TYPE_IPC_EXPOSE_NAME } from '../src/constants';
import { createIpcInvoke, createIpcMessage, createProxy } from '../src/renderer';

describe('createProxy', () => {
  it('should call get function with correct arguments', () => {
    const mockGet = vi.fn();

    const proxy = createProxy<{ foo: { bar: (data: any) => any } }>(mockGet);

    proxy.foo.bar({ hello: 'world' });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('foo', 'bar', { hello: 'world' });
  });

  it('should return get function return value', () => {
    const mockGet = vi.fn().mockReturnValue('result');

    const proxy = createProxy<{ test: { run: (data: string) => string } }>(mockGet);

    const result = proxy.test.run('abc');

    expect(result).toBe('result');
    expect(mockGet).toHaveBeenCalledWith('test', 'run', 'abc');
  });

  it('should allow nested destructuring', () => {
    const mockGet = vi.fn().mockReturnValue('ok');

    const proxy = createProxy<{
      foo: { bar: (data: number) => string };
    }>(mockGet);

    // 直接解构出方法
    const { bar } = proxy.foo;

    const result = bar(123);

    expect(result).toBe('ok');
    expect(mockGet).toHaveBeenCalledWith('foo', 'bar', 123);
  });
});

describe('createIpcInvoke & createIpcMessage', () => {
  let mockInvoke: any;
  let mockMessage: any;

  beforeEach(() => {
    mockInvoke = vi.fn().mockResolvedValue('invoke-result');
    mockMessage = vi.fn().mockReturnValue(() => 'unsub');

    // Mock the window object
    (window as any)[TYPE_IPC_EXPOSE_NAME] = {
      invoke: mockInvoke,
      message: mockMessage,
    };

    // clear cache
    (globalThis as any).TypeIpcInvokes = null;
    (globalThis as any).TypeIpcMessages = null;
  });

  it('createIpcInvoke should call window.invoke with correct args', async () => {
    const invokes = createIpcInvoke<{
      user: { login: (data: { name: string }) => Promise<{ data: string; error: null }> };
    }>();

    const result = await invokes.user.login({ name: 'alice' });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith({
      name: 'user',
      method: 'login',
      data: {
        name: 'alice',
      },
    });
    expect(result).toBe('invoke-result');
  });

  it('createIpcInvoke should return cached instance', () => {
    const i1 = createIpcInvoke();
    const i2 = createIpcInvoke();
    expect(i1).toBe(i2); // check if it's the same instance
  });

  it('createIpcMessage should call window.message with correct args', () => {
    const messages = createIpcMessage<{
      system: { onReady: (cb: (msg: string) => void) => () => void };
    }>();

    const unsubscribe = messages.system.onReady((msg) => {
      // eslint-disable-next-line no-console
      console.log('Message received:', msg);
    });

    expect(mockMessage).toHaveBeenCalledTimes(1);
    expect(mockMessage.mock.calls[0][0]).toMatchObject({
      name: 'system',
      method: 'onReady',
    });
    expect(typeof mockMessage.mock.calls[0][0].callback).toBe('function');

    expect(unsubscribe()).toBe('unsub');
  });

  it('createIpcMessage should return cached instance', () => {
    const m1 = createIpcMessage();
    const m2 = createIpcMessage();
    expect(m1).toBe(m2);
  });
});
