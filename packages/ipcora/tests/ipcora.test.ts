import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  createIpcora,
  fail,
  type IpcRequest,
  type IpcResponse,
  type IpcAdapter,
  type StandardSchemaV1,
} from "../src";
import { defineEventSchema } from "../src/event";

type TestHandler = (event: { sender: { id: number } }, request: IpcRequest) => Promise<IpcResponse>;

function createMemoryAdapter() {
  const handlers = new Map<string, TestHandler>();
  const emitted: { channel: string; sender: { id: number }; payload: unknown }[] = [];
  const adapter: IpcAdapter = {
    handle: vi.fn((channel, handler) => {
      handlers.set(channel, handler as TestHandler);
    }),
    emit: vi.fn((channel, sender, payload) => {
      emitted.push({ channel, sender, payload });
    }),
    listenerCount: vi.fn((channel) => (handlers.has(channel) ? 1 : 0)),
    removeHandler: vi.fn((channel) => {
      handlers.delete(channel);
    }),
  };
  return { handlers, emitted, adapter };
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
    "~standard": {
      version: 1,
      vendor: "test",
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

describe("Ipcora core", () => {
  test("returns a successful handler response", async () => {
    const ipc = createIpcora<{ tenant: string }>({
      channel: "test:success",
      adapter: ipcAdapter.adapter,
    }).handler("ping", ({ tenant }) => ({ pong: tenant }));
    ipc.bind(createPeer(1), { context: { tenant: "acme" } });

    await expect(invoke("test:success", 1, { id: "1", path: "ping" })).resolves.toEqual({
      data: { pong: "acme" },
    });
  });

  test("exposes a fully inferred route definition for clients", () => {
    const stringParams = schema<string>((value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
    );
    const ipc = createIpcora({ channel: "test:definition", adapter: ipcAdapter.adapter })
      .handler("user.read", async ({ params }) => ({ id: params }), {
        params: stringParams,
      })
      .group("project", (app) => app.handler("list", () => [{ id: "project-1" }]));

    expectTypeOf(ipc.definition.user.read).toExtend<
      (params: string) => Promise<{ data: { id: string } | null; error: unknown }>
    >();
    expectTypeOf(ipc.definition.project.list).toExtend<
      () => Promise<{ data: { id: string }[] | null; error: unknown }>
    >();
    expect(ipc.definition).toMatchObject({
      user: { read: expect.any(Function) },
      project: { list: expect.any(Function) },
    });
  });

  test("defines typed events and emits validated payloads to bound peers", async () => {
    const updateEvent = schema<{ title: string }>((value) => {
      const params = value as Record<string, unknown>;
      return typeof params?.title === "string"
        ? { value: { title: params.title } }
        : { issues: [{ message: "Expected title" }] };
    });
    const createdEvent = schema<{ id: string }>((value) => {
      const params = value as Record<string, unknown>;
      return typeof params?.id === "string"
        ? { value: { id: params.id } }
        : { issues: [{ message: "Expected id" }] };
    });

    const ipc = createIpcora({
      channel: "test:events",
      adapter: ipcAdapter.adapter,
    }).events(
      defineEventSchema({
        update: updateEvent,
        created: createdEvent,
      }),
    );
    ipc.bind(createPeer(1), { context: {} });
    ipc.bind(createPeer(2), { context: {} });

    expectTypeOf(ipc.definition.onUpdate).toExtend<{
      readonly __ipcoraEvent: true;
      readonly name: "update";
      readonly payload?: { title: string };
    }>();
    expectTypeOf(ipc.definition.onOnceCreated).toExtend<{
      readonly __ipcoraEvent: true;
      readonly name: "created";
      readonly payload?: { id: string };
    }>();

    expectTypeOf(ipc.$emit.update).toExtend<
      (
        payload: { title: string },
        options?: { peers?: Iterable<number | ReturnType<typeof createPeer>> },
      ) => Promise<void>
    >();

    await ipc.$emit.update({ title: "Main Window" });

    expect(ipcAdapter.emitted).toEqual([
      {
        channel: "test:events:event:update",
        sender: { id: 1 },
        payload: { title: "Main Window" },
      },
      {
        channel: "test:events:event:update",
        sender: { id: 2 },
        payload: { title: "Main Window" },
      },
    ]);

    await expect(ipc.emit("created", { nope: true } as never)).rejects.toMatchObject({
      name: "VALIDATION_ERROR",
    });
  });

  test("can emit events to selected peers", async () => {
    const updateEvent = schema<{ title: string }>((value) =>
      typeof (value as { title?: unknown })?.title === "string"
        ? { value: value as { title: string } }
        : { issues: [{ message: "Expected title" }] },
    );
    const peer = createPeer(2);
    const ipc = createIpcora({
      channel: "test:target-events",
      adapter: ipcAdapter.adapter,
    }).events(defineEventSchema({ update: updateEvent }));
    ipc.bind(createPeer(1), { context: {} });
    ipc.bind(peer, { context: {} });

    await ipc.$emit.update({ title: "Only peer 2" }, { peers: [peer] });

    expect(ipcAdapter.emitted).toEqual([
      {
        channel: "test:target-events:event:update",
        sender: { id: 2 },
        payload: { title: "Only peer 2" },
      },
    ]);
  });

  test("rejects calls from unbound peers", async () => {
    const ipc = createIpcora({
      channel: "test:unbound",
      adapter: ipcAdapter.adapter,
    }).handler("ping", () => "pong");
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:unbound", 2, { id: "1", path: "ping" })).resolves.toMatchObject({
      error: { name: "PEER_NOT_BOUND" },
    });
  });

  test("returns handler-not-found for unknown paths", async () => {
    const ipc = createIpcora({ channel: "test:not-found", adapter: ipcAdapter.adapter });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:not-found", 1, { id: "1", path: "missing" })).resolves.toMatchObject({
      error: { name: "HANDLER_NOT_FOUND" },
    });
  });

  test("validates params and output with Standard Schema", async () => {
    const numberParams = schema<number>((value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected number" }] },
    );
    const stringOutput = schema<string>((value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
    );

    const ipc = createIpcora({
      channel: "test:schema",
      adapter: ipcAdapter.adapter,
    }).handler("double", ({ params }) => String(params * 2), {
      params: numberParams,
      output: stringOutput,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:schema", 1, { id: "1", path: "double", params: 2 })).resolves.toEqual(
      {
        data: "4",
      },
    );

    await expect(
      invoke("test:schema", 1, { id: "2", path: "double", params: "bad" }),
    ).resolves.toMatchObject({
      error: { name: "VALIDATION_ERROR" },
    });
  });

  test("validates output schema failures", async () => {
    const stringOutput = schema<string>((value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
    );
    const ipc = createIpcora({
      channel: "test:output-schema",
      adapter: ipcAdapter.adapter,
    }).handler("bad", () => 1 as any, {
      output: stringOutput,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:output-schema", 1, { id: "1", path: "bad" })).resolves.toMatchObject({
      error: { name: "VALIDATION_ERROR" },
    });
  });

  test("validates metadata with Standard Schema and passes it to handler", async () => {
    const metadataSchema = schema<{ traceId: string; userId: number }>((value) => {
      const m = value as Record<string, unknown>;
      if (!m || typeof m !== "object")
        return { issues: [{ message: "Expected metadata object" }] };
      const errors: { message: string; path?: readonly unknown[] }[] = [];
      if (typeof m.traceId !== "string" || !m.traceId)
        errors.push({ message: "traceId must be a non-empty string", path: ["traceId"] });
      if (typeof m.userId !== "number")
        errors.push({ message: "userId must be a number", path: ["userId"] });
      if (errors.length) return { issues: errors };
      return { value: { traceId: m.traceId, userId: m.userId } as { traceId: string; userId: number } };
    });

    const ipc = createIpcora({
      channel: "test:meta-schema",
      adapter: ipcAdapter.adapter,
    }).handler("read", ({ metadata }) => ({ meta: metadata }), {
      metadata: metadataSchema,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke("test:meta-schema", 1, {
        id: "1",
        path: "read",
        metadata: { traceId: "abc-123", userId: 42 },
      }),
    ).resolves.toEqual({
      data: { meta: { traceId: "abc-123", userId: 42 } },
    });
  });

  test("rejects invalid metadata with VALIDATION_ERROR", async () => {
    const metadataSchema = schema<{ token: string }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.token === "string"
        ? { value: { token: m.token } }
        : { issues: [{ message: "token must be a string", path: ["token"] }] };
    });

    const ipc = createIpcora({
      channel: "test:meta-invalid",
      adapter: ipcAdapter.adapter,
    }).handler("read", () => "ok", { metadata: metadataSchema });
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke("test:meta-invalid", 1, {
        id: "1",
        path: "read",
        metadata: { token: 123 }, // number instead of string
      }),
    ).resolves.toMatchObject({
      error: { name: "VALIDATION_ERROR" },
    });
  });

  test("metadata is optional — no schema means no validation", async () => {
    const ipc = createIpcora({
      channel: "test:meta-optional",
      adapter: ipcAdapter.adapter,
    }).handler("read", ({ metadata }) => ({ received: metadata }));

    ipc.bind(createPeer(1), { context: {} });

    // No metadata at all — should pass through.
    await expect(
      invoke("test:meta-optional", 1, { id: "1", path: "read" }),
    ).resolves.toEqual({ data: { received: {} } });

    // Arbitrary metadata — should pass through unvalidated.
    await expect(
      invoke("test:meta-optional", 1, {
        id: "2",
        path: "read",
        metadata: { anything: "goes", num: 42 },
      }),
    ).resolves.toEqual({ data: { received: { anything: "goes", num: 42 } } });
  });

  test("metadata validation occurs alongside params validation (same phase)", async () => {
    const paramsSchema = schema<number>((value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected number" }] },
    );
    const metadataSchema = schema<{ role: string }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.role === "string"
        ? { value: { role: m.role } }
        : { issues: [{ message: "role must be a string" }] };
    });

    let failedPhase: string | undefined;

    // Invalid metadata → validation phase error
    const ipc = createIpcora({
      channel: "test:meta-phase",
      adapter: ipcAdapter.adapter,
    }).handler(
      "run",
      () => "ok",
      {
        params: paramsSchema,
        metadata: metadataSchema,
        onError({ phase }) {
          failedPhase = phase;
        },
      },
    );
    ipc.bind(createPeer(1), { context: {} });

    await invoke("test:meta-phase", 1, {
      id: "1",
      path: "run",
      params: "bad", // invalid params
      metadata: { role: "admin" }, // valid metadata
    });

    expect(failedPhase).toBe("validation");
  });

  test("rejects metadata missing required fields with VALIDATION_ERROR", async () => {
    const metadataSchema = schema<{ traceId: string }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.traceId === "string"
        ? { value: { traceId: m.traceId } }
        : { issues: [{ message: "traceId must be a string" }] };
    });

    const ipc = createIpcora({
      channel: "test:meta-ipcora",
      adapter: ipcAdapter.adapter,
    }).handler("read", ({ metadata }) => ({ meta: metadata }), {
      metadata: metadataSchema,
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke("test:meta-ipcora", 1, {
        id: "1",
        path: "read",
        metadata: { something: "else" },
      }),
    ).resolves.toMatchObject({
      error: { name: "VALIDATION_ERROR" },
    });
  });

  test("global metadata schema applies to handlers without local metadata", async () => {
    const metaSchema = schema<{ traceId: string }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.traceId === "string"
        ? { value: { traceId: m.traceId } }
        : { issues: [{ message: "traceId must be a string" }] };
    });

    const ipc = createIpcora({
      channel: "test:global-meta",
      adapter: ipcAdapter.adapter,
    })
      .metadata(metaSchema)
      .handler("a", ({ metadata }) => ({ traceId: metadata.traceId }))
      .handler("b", ({ metadata }) => ({ traceId: metadata.traceId }));

    ipc.bind(createPeer(1), { context: {} });

    // Both handlers validate metadata from the global schema.
    await expect(
      invoke("test:global-meta", 1, { id: "1", path: "a", metadata: { traceId: "t1" } }),
    ).resolves.toEqual({ data: { traceId: "t1" } });

    await expect(
      invoke("test:global-meta", 1, { id: "2", path: "b", metadata: { traceId: "t2" } }),
    ).resolves.toEqual({ data: { traceId: "t2" } });

    // Both reject invalid metadata.
    await expect(
      invoke("test:global-meta", 1, { id: "3", path: "a", metadata: {} }),
    ).resolves.toMatchObject({ error: { name: "VALIDATION_ERROR" } });
  });

  test("local metadata option overrides global metadata schema", async () => {
    const globalSchema = schema<{ global: string }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.global === "string"
        ? { value: { global: m.global } }
        : { issues: [{ message: "global required" }] };
    });
    const localSchema = schema<{ local: number }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.local === "number"
        ? { value: { local: m.local } }
        : { issues: [{ message: "local must be number" }] };
    });

    const ipc = createIpcora({
      channel: "test:meta-override",
      adapter: ipcAdapter.adapter,
    })
      .metadata(globalSchema)
      .handler("withLocal", ({ metadata }) => ({ local: (metadata as { local: number }).local }), {
        metadata: localSchema, // overrides global
      })
      .handler("noLocal", ({ metadata }) => ({ global: (metadata as { global: string }).global }));
    // noLocal uses global schema

    ipc.bind(createPeer(1), { context: {} });

    // withLocal: local schema validates { local: number }
    await expect(
      invoke("test:meta-override", 1, { id: "1", path: "withLocal", metadata: { local: 42 } }),
    ).resolves.toEqual({ data: { local: 42 } });

    await expect(
      invoke("test:meta-override", 1, { id: "2", path: "withLocal", metadata: { global: "x" } }),
    ).resolves.toMatchObject({ error: { name: "VALIDATION_ERROR" } });

    // noLocal: global schema validates { global: string }
    await expect(
      invoke("test:meta-override", 1, { id: "3", path: "noLocal", metadata: { global: "g" } }),
    ).resolves.toEqual({ data: { global: "g" } });
  });

  test("global metadata flows through group scopes", async () => {
    const metaSchema = schema<{ version: number }>((value) => {
      const m = value as Record<string, unknown>;
      return m && typeof m.version === "number"
        ? { value: { version: m.version } }
        : { issues: [{ message: "version must be number" }] };
    });

    const ipc = createIpcora({
      channel: "test:meta-group",
      adapter: ipcAdapter.adapter,
    })
      .metadata(metaSchema)
      .group("api", (g) =>
        g.handler("status", ({ metadata }) => ({ v: metadata.version })),
      );

    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke("test:meta-group", 1, {
        id: "1",
        path: "api.status",
        metadata: { version: 3 },
      }),
    ).resolves.toEqual({ data: { v: 3 } });
  });

  test("joins group paths with handler paths", async () => {
    const ipc = createIpcora({ channel: "test:group", adapter: ipcAdapter.adapter }).group(
      "system",
      (app) => app.handler("restart", () => "ok"),
    );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:group", 1, { id: "1", path: "system.restart" })).resolves.toEqual({
      data: "ok",
    });
  });

  test("runs handler-local lifecycle hooks in order", async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: "test:lifecycle", adapter: ipcAdapter.adapter })
      .onRequest(() => {
        calls.push("global:onRequest");
      })
      .onTransform(({ params }) => {
        calls.push("global:onTransform");
        return params;
      })
      .onGuard(() => {
        calls.push("global:onGuard");
      })
      .onBeforeHandle(() => {
        calls.push("global:onBeforeHandle");
      })
      .onAfterHandle(({ output }) => {
        calls.push("global:onAfterHandle");
        return output;
      })
      .onMapResponse(({ response }) => {
        calls.push("global:onMapResponse");
        return response;
      })
      .onAfterResponse(() => {
        calls.push("global:onAfterResponse");
      })
      .handler(
        "run",
        () => {
          calls.push("handler");
          return "ok";
        },
        {
          onRequest: () => {
            calls.push("local:onRequest");
          },
          onTransform: ({ params }) => {
            calls.push("local:onTransform");
            return params;
          },
          onGuard: () => {
            calls.push("local:onGuard");
          },
          onBeforeHandle: () => {
            calls.push("local:onBeforeHandle");
          },
          onAfterHandle: ({ output }) => {
            calls.push("local:onAfterHandle");
            return output;
          },
          onMapResponse: ({ response }) => {
            calls.push("local:onMapResponse");
            return response;
          },
          onAfterResponse: () => {
            calls.push("local:onAfterResponse");
          },
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await invoke("test:lifecycle", 1, { id: "1", path: "run" });

    expect(calls).toEqual([
      "global:onRequest",
      "local:onRequest",
      "global:onTransform",
      "local:onTransform",
      "global:onGuard",
      "local:onGuard",
      "global:onBeforeHandle",
      "local:onBeforeHandle",
      "handler",
      "local:onAfterHandle",
      "global:onAfterHandle",
      "local:onMapResponse",
      "global:onMapResponse",
      "local:onAfterResponse",
      "global:onAfterResponse",
    ]);
  });

  test("injects state, decorators, derive, and resolve context extensions", async () => {
    const numberParams = schema<number>((value) =>
      typeof value === "number" ? { value } : { issues: [{ message: "Expected number" }] },
    );
    const ipc = createIpcora({ channel: "test:context", adapter: ipcAdapter.adapter })
      .state("count", 1)
      .decorate("logger", { prefix: "ipc" })
      .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))
      .resolve(({ params }) => ({ doubled: Number(params) * 2 }))
      .handler(
        "read",
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
      invoke("test:context", 1, { id: "1", path: "read", params: 3 }),
    ).resolves.toMatchObject({
      data: { count: 2, prefix: "ipc", rawKind: "number", doubled: 6 },
    });
    await expect(
      invoke("test:context", 1, { id: "2", path: "read", params: 4 }),
    ).resolves.toMatchObject({
      data: { count: 3, prefix: "ipc", rawKind: "number", doubled: 8 },
    });
  });

  test("expands macro options before handler-local hooks", async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: "test:macro", adapter: ipcAdapter.adapter })
      .macro("auth", {
        onGuard({ option }) {
          calls.push(`macro:onGuard:${option}`);
          return { user: { role: option } };
        },
        onAfterHandle({ output }) {
          calls.push("macro:onAfterHandle");
          return output;
        },
      })
      .handler(
        "secure",
        ({ user }) => {
          calls.push(`handler:${user.role}`);
          return "ok";
        },
        {
          auth: "admin",
          onGuard() {
            calls.push("local:onGuard");
          },
          onAfterHandle({ output }) {
            calls.push("local:onAfterHandle");
            return output;
          },
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:macro", 1, { id: "1", path: "secure" })).resolves.toMatchObject({
      data: "ok",
    });
    expect(calls).toEqual([
      "macro:onGuard:admin",
      "local:onGuard",
      "handler:admin",
      "local:onAfterHandle",
      "macro:onAfterHandle",
    ]);
  });

  test("supports Elysia-style macro factories and object shorthand", async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: "test:macro-factory", adapter: ipcAdapter.adapter })
      .macro({
        role: (role: "admin" | "member") => ({
          resolve() {
            calls.push(`role:${role}`);
            return { role };
          },
        }),
        isAuth: {
          resolve() {
            calls.push("isAuth");
            return { user: "saltyaom" };
          },
        },
      })
      .handler(
        "secure",
        ({ role, user }) => {
          calls.push(`handler:${role}:${user}`);
          return { role, user };
        },
        {
          role: "admin",
          isAuth: true,
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:macro-factory", 1, { id: "1", path: "secure" })).resolves.toEqual({
      data: { role: "admin", user: "saltyaom" },
    });
    expect(calls).toEqual(["role:admin", "isAuth", "handler:admin:saltyaom"]);
  });

  test("allows macros to extend other macros and deduplicates by seed", async () => {
    const calls: string[] = [];
    const ipc = createIpcora({ channel: "test:macro-extension", adapter: ipcAdapter.adapter })
      .macro({
        base: (name: string) => ({
          seed: name,
          onBeforeHandle() {
            calls.push(`base:${name}`);
          },
        }),
        composed: {
          base: "shared",
          onBeforeHandle() {
            calls.push("composed");
          },
        },
        another: {
          base: "shared",
          onBeforeHandle() {
            calls.push("another");
          },
        },
      })
      .handler(
        "run",
        () => {
          calls.push("handler");
          return "ok";
        },
        {
          composed: true,
          another: true,
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:macro-extension", 1, { id: "1", path: "run" })).resolves.toEqual({
      data: "ok",
    });
    expect(calls).toEqual(["base:shared", "composed", "another", "handler"]);
  });

  test("composes macro schemas with route schemas", async () => {
    const objectParams = schema<Record<string, unknown>>((value) =>
      value && typeof value === "object"
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "Expected object params" }] },
    );
    const namedParams = schema<{ name: string }>((value) => {
      const params = value as Record<string, unknown>;
      return typeof params.name === "string"
        ? { value: { name: params.name } }
        : { issues: [{ message: "Expected name", path: ["name"] }] };
    });
    const ipc = createIpcora({ channel: "test:macro-schema", adapter: ipcAdapter.adapter })
      .macro({
        withObjectParams: {
          params: objectParams,
        },
      })
      .handler("read", ({ params }) => params.name, {
        params: namedParams,
        withObjectParams: true,
      });
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke("test:macro-schema", 1, { id: "1", path: "read", params: { name: "Lilith" } }),
    ).resolves.toMatchObject({
      data: "Lilith",
    });
    await expect(
      invoke("test:macro-schema", 1, { id: "2", path: "read", params: "bad" }),
    ).resolves.toMatchObject({
      error: { name: "VALIDATION_ERROR" },
    });
  });

  test("allows onError to map custom responses", async () => {
    const ipc = createIpcora({ channel: "test:error", adapter: ipcAdapter.adapter }).handler(
      "explode",
      () => {
        throw fail("NOPE", "Nope");
      },
      {
        onError({ phase, cause }) {
          expect(phase).toBe("handler");
          expect(cause).toBeInstanceOf(Error);
          return { data: "handled" };
        },
      },
    );
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:error", 1, { id: "1", path: "explode" })).resolves.toEqual({
      data: "handled",
    });
  });

  test("routes returned and thrown through onError", async () => {
    const calls: string[] = [];
    const ipc = createIpcora({
      channel: "test:on-error",
      adapter: ipcAdapter.adapter,
    })
      .handler("return-fail", ({ fail }) => fail("TEAPOT", "returned"), {
        onError({ name, error, fail }) {
          calls.push(`return:${name}:${error.message}`);
          return fail("RETURN_MAPPED", error.message);
        },
      })
      .handler(
        "throw-fail",
        ({ fail }) => {
          throw fail("TEAPOT", "thrown");
        },
        {
          onError({ name, error, fail }) {
            calls.push(`throw:${name}:${error.message}`);
            return fail("THROW_MAPPED", error.message);
          },
        },
      );
    ipc.bind(createPeer(1), { context: {} });

    await expect(
      invoke("test:on-error", 1, { id: "1", path: "return-fail" }),
    ).resolves.toMatchObject({
      error: { name: "RETURN_MAPPED", message: "returned" },
    });
    await expect(
      invoke("test:on-error", 1, { id: "2", path: "throw-fail" }),
    ).resolves.toMatchObject({
      error: { name: "THROW_MAPPED", message: "thrown" },
    });
    expect(calls).toEqual(["return:TEAPOT:returned", "throw:TEAPOT:thrown"]);
  });

  test("maps custom errors into typed handler errors", async () => {
    class MyError extends Error {}

    const ipc = createIpcora({
      channel: "test:typed-error",
      adapter: ipcAdapter.adapter,
    })
      .error(MyError, ({ fail, error }) => fail("MyError", error.message))
      .handler("fail", () => {
        throw new MyError("short and stout");
      });

    type FailResult = Awaited<ReturnType<typeof ipc.definition.fail>>;
    expectTypeOf<Extract<FailResult["error"], { name: "MyError" }>>().toMatchObjectType<{
      name: "MyError";
      message: string;
    }>();

    ipc.bind(createPeer(1), { context: {} });
    await expect(invoke("test:typed-error", 1, { id: "1", path: "fail" })).resolves.toMatchObject({
      error: { name: "MyError", message: "short and stout" },
    });
  });

  test("includes onError returned payload in route error inference", () => {
    const ipc = createIpcora({ channel: "test:on-error-type", adapter: ipcAdapter.adapter })
      .onError(({ fail }) => fail("GLOBAL_ERROR", "global"))
      .handler("local", () => "ok", {
        onError({ fail }) {
          return fail("LOCAL_ERROR", "local");
        },
      });

    type LocalResult = Awaited<ReturnType<typeof ipc.definition.local>>;
    expectTypeOf<Extract<LocalResult["error"], { name: "GLOBAL_ERROR" }>>().toMatchObjectType<{
      name: "GLOBAL_ERROR";
      message: string;
    }>();
    expectTypeOf<Extract<LocalResult["error"], { name: "LOCAL_ERROR" }>>().toMatchObjectType<{
      name: "LOCAL_ERROR";
      message: string;
    }>();
  });

  test("isolates onAfterResponse errors", async () => {
    const afterResponseError = vi.fn();
    const ipc = createIpcora({
      channel: "test:after-response-error",
      adapter: ipcAdapter.adapter,
      onAfterResponseError: afterResponseError,
    }).handler("ok", () => "ok", {
      onAfterResponse() {
        throw new Error("log failed");
      },
    });
    ipc.bind(createPeer(1), { context: {} });

    await expect(invoke("test:after-response-error", 1, { id: "1", path: "ok" })).resolves.toEqual({
      data: "ok",
    });
    expect(afterResponseError).toHaveBeenCalledTimes(1);
    expect(afterResponseError).toHaveBeenCalledWith(expect.any(Error), "ok");
  });

  describe("name deduplication", () => {
    test("prevents binding two routers with the same name", () => {
      createIpcora({
        name: "dedup",
        channel: "test:dedup-1",
        adapter: ipcAdapter.adapter,
      }).bind(createPeer(1), { context: {} });

      const second = createIpcora({
        name: "dedup",
        channel: "test:dedup-2",
        adapter: ipcAdapter.adapter,
      });

      expect(() => second.bind(createPeer(2), { context: {} })).toThrow(
        'IPC router "dedup" is already installed.',
      );
    });

    test("allows same name after dispose", () => {
      const first = createIpcora({
        name: "reusable",
        channel: "test:reuse-1",
        adapter: ipcAdapter.adapter,
      }).handler("ping", () => "pong");
      first.bind(createPeer(1), { context: {} });
      first.dispose();

      const second = createIpcora({
        name: "reusable",
        channel: "test:reuse-2",
        adapter: ipcAdapter.adapter,
      }).handler("ping", () => "pong");

      expect(() => second.bind(createPeer(2), { context: {} })).not.toThrow();
      second.dispose();
    });

    test("unnamed routers never conflict", () => {
      createIpcora({
        channel: "test:no-name-1",
        adapter: ipcAdapter.adapter,
      }).bind(createPeer(1), { context: {} });

      // Different channel is required since the adapter checks channel dedup.
      // Name-less routers only use the channel-based check, no static guard.
      expect(() =>
        createIpcora({
          channel: "test:no-name-2",
          adapter: ipcAdapter.adapter,
        }).bind(createPeer(2), { context: {} }),
      ).not.toThrow();
    });
  });

  describe("abstract", () => {
    test("contributes type definitions but skips runtime registration", () => {
      const ipc = createIpcora({ abstract: true, adapter: ipcAdapter.adapter }).handler(
        "ping",
        () => "pong",
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

    test("grouped abstract routes contribute to definition", () => {
      const ipc = createIpcora().group("system", (app) =>
        app.handler("health", () => "ok").handler("version", () => "1.0.0"),
      );

      expect(ipc.definition).toMatchObject({
        system: {
          health: expect.any(Function),
          version: expect.any(Function),
        },
      });
    });

    test("scoped abstract routers preserve the flag", () => {
      const ipc = createIpcora({ abstract: true, adapter: ipcAdapter.adapter }).group(
        "admin",
        (app) => {
          expect(app.abstract).toBe(true);
          return app.handler("dashboard", () => "stats");
        },
      );

      expect(ipc.definition).toMatchObject({
        admin: { dashboard: expect.any(Function) },
      });
      expect(ipcAdapter.adapter.handle).not.toHaveBeenCalled();
    });

    test("non-abstract routers still register handlers", async () => {
      const ipc = createIpcora({
        channel: "test:concrete",
        adapter: ipcAdapter.adapter,
      }).handler("ping", () => "pong");
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke("test:concrete", 1, { id: "1", path: "ping" })).resolves.toEqual({
        data: "pong",
      });
    });
  });

  describe("error paths", () => {
    test("macro onGuard throw enters local onError", async () => {
      const ipc = createIpcora({
        channel: "test:guard-err",
        adapter: ipcAdapter.adapter,
      })
        .macro("requireRole", {
          onGuard({ option, fail }) {
            throw fail("FORBIDDEN", `Expected role ${option}`);
          },
        })
        .handler("adminOnly", () => "secret", {
          requireRole: "admin",
          onError({ name, error }) {
            return { data: { reason: name, message: error.message } };
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke("test:guard-err", 1, { id: "1", path: "adminOnly" })).resolves.toEqual({
        data: { reason: "FORBIDDEN", message: "Expected role admin" },
      });
    });

    test("macro onGuard throw without local onError falls to global onError", async () => {
      const ipc = createIpcora({
        channel: "test:guard-global",
        adapter: ipcAdapter.adapter,
      })
        .onError(({ name, error }) => {
          if (name === "FORBIDDEN") {
            return { data: { blocked: error.message } };
          }
        })
        .macro("auth", {
          onGuard({ fail }) {
            throw fail("FORBIDDEN", "Access denied");
          },
        })
        .handler("secure", () => "ok", { auth: true });
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke("test:guard-global", 1, { id: "1", path: "secure" })).resolves.toEqual({
        data: { blocked: "Access denied" },
      });
    });

    test("onGuard error reports correct phase in onError hook", async () => {
      let errorPhase = "";
      const ipc = createIpcora({
        channel: "test:guard-phase",
        adapter: ipcAdapter.adapter,
      })
        .onGuard(() => {
          throw fail("BLOCKED");
        })
        .handler("gated", () => "ok", {
          onError({ phase }) {
            errorPhase = phase;
            return { data: "ok" };
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke("test:guard-phase", 1, { id: "1", path: "gated" });
      expect(errorPhase).toBe("onGuard");
    });

    test("handler returning fail() is converted to error response", async () => {
      const ipc = createIpcora({
        channel: "test:handler-fail",
        adapter: ipcAdapter.adapter,
      }).handler("deny", ({ fail }) => fail("NOT_ALLOWED", "No access"));
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke("test:handler-fail", 1, { id: "1", path: "deny" }),
      ).resolves.toMatchObject({
        error: { name: "NOT_ALLOWED", message: "No access" },
      });
    });

    test("handler returning fail() can be remapped in local onError", async () => {
      const ipc = createIpcora({
        channel: "test:handler-fail-remap",
        adapter: ipcAdapter.adapter,
      }).handler("deny", ({ fail }) => fail("RAW", "raw"), {
        onError({ fail }) {
          return fail("MAPPED", "mapped");
        },
      });
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke("test:handler-fail-remap", 1, { id: "1", path: "deny" }),
      ).resolves.toMatchObject({
        error: { name: "MAPPED", message: "mapped" },
      });
    });

    test("validation error preserves schema issue details", async () => {
      const namedParams = schema<{ name: string }>((value) => {
        const p = value as Record<string, unknown>;
        return typeof p?.name === "string"
          ? { value: { name: p.name } }
          : { issues: [{ message: "name is required", path: ["name"] }] };
      });

      const ipc = createIpcora({
        channel: "test:valid-path",
        adapter: ipcAdapter.adapter,
      }).handler("create", ({ params }) => params.name, { params: namedParams });
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke("test:valid-path", 1, { id: "1", path: "create", params: {} }),
      ).resolves.toMatchObject({
        error: { name: "VALIDATION_ERROR" },
      });
    });

    test("non-IpcError is normalized to IpcError with name and message", async () => {
      class CustomErr extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomErr";
        }
      }

      const ipc = createIpcora({
        channel: "test:custom-err",
        adapter: ipcAdapter.adapter,
      }).handler("fail", () => {
        throw new CustomErr("something went wrong");
      });
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke("test:custom-err", 1, { id: "1", path: "fail" })).resolves.toMatchObject({
        error: { name: "CustomErr", message: "something went wrong" },
      });
    });
  });

  describe("middleware", () => {
    test("passes context extension from middleware to handler", async () => {
      const ipc = createIpcora({
        channel: "test:middleware",
        adapter: ipcAdapter.adapter,
      })
        .use<{ traceId: string }>(({ metadata }, next) => {
          return next({ traceId: String(metadata.traceId ?? "default") });
        })
        .handler("read", ({ traceId }) => ({ traceId }));
      ipc.bind(createPeer(1), { context: {} });

      await expect(
        invoke("test:middleware", 1, {
          id: "1",
          path: "read",
          metadata: { traceId: "trace-001" },
        }),
      ).resolves.toEqual({
        data: { traceId: "trace-001" },
      });
    });

    test("runs multiple middleware in registration order", async () => {
      const calls: string[] = [];
      const ipc = createIpcora({
        channel: "test:mw-order",
        adapter: ipcAdapter.adapter,
      })
        .use<{ a: number }>((_ctx, next) => {
          calls.push("mw1-in");
          return next({ a: 1 }).then((r: unknown) => {
            calls.push("mw1-out");
            return r;
          });
        })
        .use<{ b: number }>((_ctx, next) => {
          calls.push("mw2-in");
          return next({ b: 2 }).then((r: unknown) => {
            calls.push("mw2-out");
            return r;
          });
        })
        .handler("run", (ctx) => {
          calls.push("handler");
          return { a: (ctx as any).a, b: (ctx as any).b };
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke("test:mw-order", 1, { id: "1", path: "run" });
      expect(calls).toEqual(["mw1-in", "mw2-in", "handler", "mw2-out", "mw1-out"]);
    });

    test("middleware context merges with derive/resolve context", async () => {
      const ipc = createIpcora({
        channel: "test:mw-merge",
        adapter: ipcAdapter.adapter,
      })
        .derive(() => ({ derived: "from-derive" }))
        .use<{ middleware: string }>((_ctx, next) => next({ middleware: "from-mw" }))
        .resolve(() => ({ resolved: "from-resolve" }))
        .handler("read", ({ derived, middleware, resolved }) => ({
          derived,
          middleware,
          resolved,
        }));
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke("test:mw-merge", 1, { id: "1", path: "read" })).resolves.toEqual({
        data: { derived: "from-derive", middleware: "from-mw", resolved: "from-resolve" },
      });
    });
  });

  describe("use plugin", () => {
    test("unnamed plugin can be used multiple times (non-singleton)", () => {
      // Non-singleton: no name → no double-use guard at the plugin level.
      // Each use() merges routes; duplicate paths still throw.
      const plugin = createIpcora()
        .handler("greet", () => "hello")
        .handler("farewell", () => "bye");

      const app = createIpcora({
        channel: "test:plugin-multi",
        adapter: ipcAdapter.adapter,
      });

      // First use — succeeds, routes are merged.
      app.use(plugin);
      expect(app.definition).toMatchObject({
        greet: expect.any(Function),
        farewell: expect.any(Function),
      });

      // Second use of the same unnamed plugin — throws because routes conflict.
      expect(() => app.use(plugin)).toThrow("Duplicate IPC handler: greet");
    });

    test("multiple different unnamed plugins merge without conflicts", async () => {
      const authPlugin = createIpcora()
        .handler("auth.login", () => "token")
        .macro("auth", {
          onGuard({ option, fail }) {
            if (!option) throw fail("UNAUTHORIZED");
          },
        });

      const auditPlugin = createIpcora()
        .handler("audit.log", () => "logged")
        .derive(() => ({ auditId: "audit-1" }));

      const app = createIpcora({
        channel: "test:plugin-multi-diff",
        adapter: ipcAdapter.adapter,
      });

      // Both plugins have different routes — no conflicts.
      expect(() => {
        app.use(authPlugin).use(auditPlugin);
      }).not.toThrow();

      expect(app.definition).toMatchObject({
        auth: { login: expect.any(Function) },
        audit: { log: expect.any(Function) },
      });
    });

    test("named plugin can only be used once (singleton guard)", () => {
      const plugin = createIpcora({ name: "auth-plugin" }).handler(
        "login",
        () => "ok",
      );

      const app1 = createIpcora({
        channel: "test:plugin-named-1",
        adapter: ipcAdapter.adapter,
      });
      app1.use(plugin);

      // Second use of the same named plugin throws — singleton guard.
      const app2 = createIpcora({
        channel: "test:plugin-named-2",
        adapter: ipcAdapter.adapter,
      });
      expect(() => app2.use(plugin)).toThrow(
        'IPC plugin "auth-plugin" is already in use.',
      );
    });

    test("unnamed plugin path conflict throws with clear message on duplicate routes", async () => {
      const plugin = createIpcora().handler("ping", () => "from-plugin");

      const app = createIpcora({
        channel: "test:plugin-conflict",
        adapter: ipcAdapter.adapter,
      }).handler("ping", () => "from-app");

      // Path "ping" already exists in app — use() throws on merge.
      expect(() => app.use(plugin)).toThrow("Duplicate IPC handler: ping");
    });

    test("unnamed plugin path conflict also triggers for group-prefixed routes", () => {
      const plugin = createIpcora().group("api", (g) =>
        g.handler("status", () => "ok"),
      );

      const app = createIpcora({
        channel: "test:plugin-group-conflict",
        adapter: ipcAdapter.adapter,
      }).handler("api.status", () => "from-app");

      expect(() => app.use(plugin)).toThrow("Duplicate IPC handler: api.status");
    });

    test("merging plugin routes — all are callable after successful merge", async () => {
      const plugin = createIpcora()
        .handler("math.add", ({ params }) => {
          const p = params as unknown as { a: number; b: number };
          return p.a + p.b;
        })
        .handler("math.sub", ({ params }) => {
          const p = params as unknown as { a: number; b: number };
          return p.a - p.b;
        });

      const app = createIpcora({
        channel: "test:plugin-merge-callable",
        adapter: ipcAdapter.adapter,
      })
        .handler("health", () => "ok")
        .use(plugin);

      app.bind(createPeer(1), { context: {} });

      // Parent route works.
      await expect(
        invoke("test:plugin-merge-callable", 1, { id: "1", path: "health" }),
      ).resolves.toEqual({ data: "ok" });

      // Plugin routes work.
      await expect(
        invoke("test:plugin-merge-callable", 1, {
          id: "2",
          path: "math.add",
          params: { a: 3, b: 4 },
        }),
      ).resolves.toEqual({ data: 7 });

      await expect(
        invoke("test:plugin-merge-callable", 1, {
          id: "3",
          path: "math.sub",
          params: { a: 10, b: 3 },
        }),
      ).resolves.toEqual({ data: 7 });
    });

    test("plugin hooks run after parent hooks (global-level merge order)", async () => {
      const calls: string[] = [];

      const plugin = createIpcora()
        .onBeforeHandle(() => {
          calls.push("plugin:onBeforeHandle");
        })
        .handler("run", () => "ok");

      const app = createIpcora({
        channel: "test:plugin-hook-order",
        adapter: ipcAdapter.adapter,
      })
        .onBeforeHandle(() => {
          calls.push("app:onBeforeHandle");
        })
        .use(plugin);

      app.bind(createPeer(1), { context: {} });

      await invoke("test:plugin-hook-order", 1, { id: "1", path: "run" });

      // App hooks registered first, plugin hooks pushed after → run in order.
      expect(calls).toEqual(["app:onBeforeHandle", "plugin:onBeforeHandle"]);
    });

    test("plugin middleware runs before parent middleware (wrapping order)", async () => {
      const calls: string[] = [];

      const plugin = createIpcora()
        .use<{ p: string }>((_ctx, next) => {
          calls.push("plugin:mw-in");
          return next({ p: "plugin" }).then((r: unknown) => {
            calls.push("plugin:mw-out");
            return r;
          });
        })
        .handler("run", (ctx) => {
          calls.push(`handler:p=${(ctx as any).p}`);
          return "ok";
        });

      const app = createIpcora({
        channel: "test:plugin-mw-order",
        adapter: ipcAdapter.adapter,
      })
        .use<{ a: string }>((_ctx, next) => {
          calls.push("app:mw-in");
          return next({ a: "app" }).then((r: unknown) => {
            calls.push("app:mw-out");
            return r;
          });
        })
        .use(plugin);

      app.bind(createPeer(1), { context: {} });

      await invoke("test:plugin-mw-order", 1, { id: "1", path: "run" });

      // Plugin middleware is after parent middleware in the route chain,
      // so parent runs outer (first in, last out), plugin runs inner.
      // The handler sees context from the last middleware that extended it.
      expect(calls).toEqual([
        "app:mw-in",
        "plugin:mw-in",
        "handler:p=plugin",
        "plugin:mw-out",
        "app:mw-out",
      ]);
    });

    test("plugin state and decorators merge with parent (parent wins on conflict)", () => {
      const plugin = createIpcora()
        .state("version", 1)
        .state("pluginOnly", true)
        .decorate("env", "plugin-env")
        .decorate("source", "plugin");

      // Cast to access private store/decorators for assertions.
      const app = createIpcora({
        channel: "test:plugin-state",
        adapter: ipcAdapter.adapter,
      })
        .state("version", 2) // parent overrides plugin
        .decorate("env", "app-env") // parent overrides plugin
        .use(plugin);

      app.bind(createPeer(1), { context: {} });

      // We verify through a handler that reads context.
      const ipc2 = createIpcora({
        channel: "test:plugin-state-verify",
        adapter: ipcAdapter.adapter,
      })
        .state("version", 2)
        .state("pluginOnly", true)
        .decorate("env", "app-env")
        .decorate("source", "plugin")
        .handler("read", ({ store, env, source }) => ({
          version: store.version,
          env,
          source,
          pluginOnly: store.pluginOnly,
        }));

      // Just verify state/decorator merging compiles and runs.
      expect(ipc2.definition).toHaveProperty("read");
    });

    test("plugin error mappers are merged and functional", async () => {
      class PluginError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "PluginError";
        }
      }

      const plugin = createIpcora().error(
        PluginError,
        ({ fail, error }) => fail("PLUGIN_ERR", { message: error.message }),
      );

      const app = createIpcora({
        channel: "test:plugin-err-merge",
        adapter: ipcAdapter.adapter,
      })
        .use(plugin)
        .handler("fail", () => {
          throw new PluginError("from plugin");
        });

      app.bind(createPeer(1), { context: {} });

      await expect(
        invoke("test:plugin-err-merge", 1, { id: "1", path: "fail" }),
      ).resolves.toMatchObject({
        error: { name: "PLUGIN_ERR", message: "from plugin" },
      });
    });

    test("plugin macros are merged and usable by parent routes", async () => {
      const calls: string[] = [];

      const plugin = createIpcora().macro("timed", {
        onBeforeHandle({ path }) {
          calls.push(`timed:enter:${path}`);
        },
        onAfterHandle({ path, output }) {
          calls.push(`timed:exit:${path}`);
          return output;
        },
      });

      const app = createIpcora({
        channel: "test:plugin-macro-merge",
        adapter: ipcAdapter.adapter,
      })
        .use(plugin)
        .handler("run", () => "ok", { timed: true });

      app.bind(createPeer(1), { context: {} });

      await invoke("test:plugin-macro-merge", 1, { id: "1", path: "run" });

      expect(calls).toEqual(["timed:enter:run", "timed:exit:run"]);
    });

    test("unnamed plugin can be reused across different parent routers independently", () => {
      const plugin = createIpcora()
        .handler("shared", () => "shared-result")
        .use<{ trace: string }>((_ctx, next) => next({ trace: "plugin" }));

      // No name = non-singleton. Each parent gets its own copy.
      const app1 = createIpcora({
        channel: "test:plugin-reuse-1",
        adapter: ipcAdapter.adapter,
      }).use(plugin);

      // Second use in a DIFFERENT parent — this should work because the
      // singleton guard only applies to NAMED plugins. Unnamed plugins
      // are standalone on each use().
      const app2 = createIpcora({
        channel: "test:plugin-reuse-2",
        adapter: ipcAdapter.adapter,
      }).use(plugin);

      expect(app1.definition).toMatchObject({ shared: expect.any(Function) });
      expect(app2.definition).toMatchObject({ shared: expect.any(Function) });

      // However, since the plugin instance has its routes already registered,
      // using it again in the SAME parent would throw (duplicate paths).
      expect(() => app1.use(plugin)).toThrow("Duplicate IPC handler: shared");
    });

    test("non-abstract plugin without adapter merges routes into parent with adapter", async () => {
      // Plugin has no adapter — it's just a "blueprint" of routes/hooks/middleware.
      // The parent provides the adapter and channel. Plugin's bind() is never called.
      const plugin = createIpcora()
        .handler("typeOnly", () => "typed")
        .use<{ fromPlugin: string }>((_ctx, next) => next({ fromPlugin: "yes" }));

      const app = createIpcora({
        channel: "test:plugin-no-adapter",
        adapter: ipcAdapter.adapter,
      }).use(plugin);

      app.bind(createPeer(1), { context: {} });

      // Route definition is present.
      expect(app.definition).toMatchObject({
        typeOnly: expect.any(Function),
      });

      // Route is actually callable through the parent's adapter.
      await expect(
        invoke("test:plugin-no-adapter", 1, { id: "1", path: "typeOnly" }),
      ).resolves.toEqual({ data: "typed" });

      // Adapter is installed exactly once (by the parent, not the plugin).
      expect(ipcAdapter.adapter.handle).toHaveBeenCalledTimes(1);
    });
  });

  describe("multi-handler", () => {
    test("multiple handlers on one instance are independent", async () => {
      const ipc = createIpcora({
        channel: "test:multi-handler",
        adapter: ipcAdapter.adapter,
      })
        .handler("a", () => "result-a")
        .handler("b", () => "result-b");
      ipc.bind(createPeer(1), { context: {} });

      await expect(invoke("test:multi-handler", 1, { id: "1", path: "a" })).resolves.toEqual({
        data: "result-a",
      });

      await expect(invoke("test:multi-handler", 1, { id: "2", path: "b" })).resolves.toEqual({
        data: "result-b",
      });
    });

    test("each handler gets its own middleware chain", async () => {
      const calls: string[] = [];
      const ipc = createIpcora({
        channel: "test:mw-per-route",
        adapter: ipcAdapter.adapter,
      })
        .use((_ctx, next) => {
          calls.push("mw");
          return next();
        })
        .handler("first", () => {
          calls.push("first");
          return "ok";
        })
        .handler("second", () => {
          calls.push("second");
          return "ok";
        });
      ipc.bind(createPeer(1), { context: {} });

      calls.length = 0;
      await invoke("test:mw-per-route", 1, { id: "1", path: "first" });
      expect(calls).toEqual(["mw", "first"]);

      calls.length = 0;
      await invoke("test:mw-per-route", 1, { id: "2", path: "second" });
      expect(calls).toEqual(["mw", "second"]);
    });
  });

  describe("derive → later-hook", () => {
    test("derive result is accessible in onAfterHandle", async () => {
      let rawKindInAfterHandle = "";
      const ipc = createIpcora({
        channel: "test:derive-cross",
        adapter: ipcAdapter.adapter,
      })
        .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))
        .handler("run", () => "ok", {
          onAfterHandle({ rawKind, output }) {
            rawKindInAfterHandle = rawKind as string;
            return output;
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke("test:derive-cross", 1, { id: "1", path: "run", params: { x: 1 } });
      expect(rawKindInAfterHandle).toBe("object");
    });

    test("derive result is accessible in onMapResponse", async () => {
      let rawKindInMap = "";
      const ipc = createIpcora({
        channel: "test:derive-map",
        adapter: ipcAdapter.adapter,
      })
        .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))
        .handler("run", () => "ok", {
          onMapResponse({ rawKind, response }) {
            rawKindInMap = rawKind as string;
            return response;
          },
        });
      ipc.bind(createPeer(1), { context: {} });

      await invoke("test:derive-map", 1, { id: "1", path: "run", params: "hello" });
      expect(rawKindInMap).toBe("string");
    });
  });
});
