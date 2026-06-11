import { describe, expect, test, vi } from "vitest";

import { createClient } from "../src/index.ts";

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

describe("createClient", () => {
  test("calls a nested method", () => {
    const invoke = vi.fn(({ channel, args }) => {
      if (channel === "window.raw.move") {
        return `Hello, ${args[0]}`;
      }
    });

    const client = createClient<typeof server>(server, {
      invoke,
    });

    expect(client.window.raw.move("window:index:0")).toBe("Hello, window:index:0");

    expect(invoke).toHaveBeenCalledOnce();

    expect(invoke).toHaveBeenCalledWith({
      path: ["window", "raw", "move"],
      channel: "window.raw.move",
      namespace: "window.raw",
      method: "move",
      args: ["window:index:0"],
    });
  });

  test("calls a top-level namespace method", () => {
    const invoke = vi.fn(({ args }) => {
      return {
        windowId: args[0],
      };
    });

    const client = createClient<typeof server>(server, {
      invoke,
    });

    expect(client.window.open("main")).toEqual({
      windowId: "main",
    });

    expect(invoke).toHaveBeenCalledWith({
      path: ["window", "open"],
      channel: "window.open",
      namespace: "window",
      method: "open",
      args: ["main"],
    });
  });

  test("passes object parameters", () => {
    const invoke = vi.fn(({ args }) => args[0]);

    const client = createClient<typeof server>(server, {
      invoke,
    });

    const params = {
      title: "Main Window",
      size: [1280, 720] as [number, number],
    };

    expect(client.window.update(params)).toEqual(params);

    expect(invoke).toHaveBeenCalledWith({
      path: ["window", "update"],
      channel: "window.update",
      namespace: "window",
      method: "update",
      args: [params],
    });
  });

  test("supports asynchronous invoke", async () => {
    const invoke = vi.fn(async ({ channel, args }) => {
      return {
        channel,
        windowId: args[0],
      };
    });

    const client = createClient<typeof server>(server, {
      invoke,
    });

    await expect(client.window.open("main")).resolves.toEqual({
      channel: "window.open",
      windowId: "main",
    });
  });

  test("does not expose client as a promise", () => {
    const client = createClient<typeof server>(server, {
      invoke: vi.fn(),
    });

    expect((client as unknown as { then?: unknown }).then).toBeUndefined();
  });

  test("throws when calling a namespace", () => {
    const client = createClient<typeof server>(server, {
      invoke: vi.fn(),
    });

    expect(() => {
      (client.window as unknown as (...args: unknown[]) => unknown)();
    }).toThrow('"window" is a namespace and cannot be called');
  });

  test("throws when accessing an unknown path", () => {
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

  test("throws when accessing a child property of a method", () => {
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

  test("does not execute the server implementation directly", () => {
    const move = vi.fn(() => "server result");

    const definition = {
      window: {
        raw: {
          move,
        },
      },
    };

    const invoke = vi.fn(() => "client result");

    const client = createClient(definition, {
      invoke,
    });

    expect(client.window.raw.move()).toBe("client result");

    expect(move).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
  });
});
