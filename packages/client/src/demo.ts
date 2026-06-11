import {
  createIpcora,
  type IpcAdapter,
  type IpcRequest,
  type IpcResponse,
  type StandardSchemaV1,
} from '@ipcora/core';

import { createClient } from './index.ts';

// Schema helpers

function schema<TOutput>(
  validate: (
    value: unknown,
  ) =>
    | { value: TOutput; issues?: undefined }
    | { issues: readonly { message: string; path?: readonly unknown[] }[] },
): StandardSchemaV1<unknown, TOutput> {
  return { '~standard': { version: 1, vendor: 'demo', validate } };
}

// Domain types

interface ProjectParams {
  name: string;
  private: boolean;
}

interface Project {
  id: string;
  name: string;
  ownerTenant: string;
  traceId: string;
  createdBy: string;
}

interface PeerContext {
  tenant: string;
}

interface User {
  id: string;
  role: 'admin' | 'member';
}

// Schemas

const projectParams = schema<ProjectParams>(value => {
  if (!value || typeof value !== 'object') {
    return { issues: [{ message: 'Expected object', path: [] }] };
  }
  const p = value as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.length === 0) {
    return { issues: [{ message: 'name is required', path: ['name'] }] };
  }
  if (typeof p.private !== 'boolean') {
    return { issues: [{ message: 'private must be boolean', path: ['private'] }] };
  }
  return { value: { name: p.name as string, private: p.private as boolean } };
});

const projectOutput = schema<Project>(value => {
  if (!value || typeof value !== 'object') {
    return { issues: [{ message: 'Expected object' }] };
  }
  const o = value as Record<string, unknown>;
  for (const k of ['id', 'name', 'ownerTenant', 'traceId', 'createdBy']) {
    if (typeof o[k] !== 'string') {
      return { issues: [{ message: `${k} must be a string`, path: [k] }] };
    }
  }
  return { value: value as Project };
});

// In-memory adapter (simulates IPC bridge)

function createMemoryAdapter() {
  type Handler = (event: { sender: { id: number } }, request: IpcRequest) => Promise<IpcResponse>;

  const handlers = new Map<string, Handler>();

  const adapter: IpcAdapter = {
    handle(channel, handler) {
      handlers.set(channel, handler as Handler);
    },
    listenerCount(channel) {
      return handlers.has(channel) ? 1 : 0;
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  return {
    adapter,
    /** Simulate a renderer-side call arriving at the main process. */
    invoke: (channel: string, senderId: number, request: IpcRequest): Promise<IpcResponse> => {
      const h = handlers.get(channel);
      if (!h) throw new Error(`No handler for channel "${channel}"`);
      return h({ sender: { id: senderId } }, request);
    },
  };
}

// Server setup (main process)

const memory = createMemoryAdapter();
const state = { projectCount: 0 };

const ipcora = createIpcora<PeerContext>({
  channel: 'demo:app',
  adapter: memory.adapter,
})
  // ── shared state ──────────────────────────────────────────────────────
  .state(state)

  // ── static decorators ─────────────────────────────────────────────────
  .decorate({ serviceName: 'project-service' })

  // ── derive raw-request context (runs BEFORE validation) ───────────────
  .derive(({ rawParams }) => ({ rawKind: typeof rawParams }))

  // ── resolve typed context (runs AFTER validation) ─────────────────────
  .resolve(() => ({ resolvedAt: Date.now() }))

  // ── middleware: inject traceId ────────────────────────────────────────
  .use<{ traceId: string }>(({ metadata }, next) => {
    return next({ traceId: String((metadata as any)?.traceId ?? 'no-trace') });
  })

  // ── error registry ────────────────────────────────────────────────────
  .error({
    ValidationError: class ValidationError extends Error {},
  })

  // ── macro: requireRole ────────────────────────────────────────────────
  // `option` is injected into the lifecycle value by the macro system.
  .macro('requireRole', {
    onGuard({ option, metadata, fail: _fail }) {
      const user = (metadata as any)?.user as User | undefined;
      if (!user) throw _fail('UNAUTHORIZED', 'Missing user metadata');
      if (user.role !== option) throw _fail('FORBIDDEN', `Role "${option}" required`);
      return { user };
    },
  })

  // ── group: project ────────────────────────────────────────────────────
  .group('project', project =>
    project
      // ── project.create ─────────────────────────────────────────────────
      .handler(
        'create',
        ({ store, tenant, traceId, user, params }) => {
          store.projectCount += 1;
          return {
            id: `${tenant}-${store.projectCount}`,
            name: params.name,
            ownerTenant: tenant,
            traceId,
            createdBy: user.id,
          };
        },
        {
          params: projectParams,
          output: projectOutput,
          requireRole: 'admin' as const,
          onError({ name, error, fail: _fail }) {
            if (name === 'FORBIDDEN') {
              return _fail('FORBIDDEN', error.message, { status: 403 });
            }
          },
        },
      )

      // ── project.list ───────────────────────────────────────────────────
      .handler('list', ({ tenant }) => [
        { id: `${tenant}-1`, name: 'Alpha' },
        { id: `${tenant}-2`, name: 'Beta' },
      ]),
  )

  // ── handler: system.health ────────────────────────────────────────────
  .handler('system.health', ({ serviceName, resolvedAt }) => ({
    service: serviceName,
    uptime: Date.now() - resolvedAt,
  }));

// ── bind a peer ──────────────────────────────────────────────────────────
ipcora.bind({ id: 1, sender: { id: 1 } }, { context: { tenant: 'acme' } });

// Client setup (renderer process)

/**
 * The client is fully typed from `ipcora.definition`.
 *
 * Every call returns `Promise<{ data: T; error: null } | { data: null; error: E }>`.
 *
 * Metadata (auth info etc.) is injected by the IPC adapter at the transport
 * layer — it is NOT part of the handler params. The handler only receives
 * validated params; lifecycle hooks read metadata from the request envelope.
 */
const client = createClient(ipcora, {
  invoke(call) {
    // In a real app the adapter injects renderer-side metadata automatically.
    return memory.invoke(call.channel, 1, {
      id: crypto.randomUUID?.() ?? Math.random().toString(36),
      path: call.channel,
      params: call.args[0],
      metadata: { user: { id: 'u1', role: 'admin' } },
    });
  },
});

// Usage — the `{ data, error }` destructuring pattern

async function demoDestructuring() {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. Success → { data: Project; error: null }
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { data, error } = await client.project.create({
      name: 'Launch Plan',
      private: true,
    });
    //     ^? Project | null              ^? IpcErrorPayload | null

    if (error) {
      console.error(`[${error.name}] ${error.message}`);
    } else {
      // data is fully typed: data.id, data.name, data.ownerTenant, ...
      console.log('created:', data.id, data.name);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Validation error → { data: null, error: { name: 'VALIDATION_ERROR' } }
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { data, error } = await client.project.create({
      name: '',
      private: true,
    });

    if (error) {
      console.log(error.name, error.message);
    }
    void data;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. No-params handler → { data, error: null }
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { data } = await client.project.list();
    //     ^? { id: string; name: string }[] | null

    if (data) {
      for (const p of data) console.log(p.id, p.name);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Health check → { data, error: null }
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { data } = await client.system.health();
    //     ^? { service: string; uptime: number } | null
    console.log(`${data?.service} running, uptime: ${data?.uptime}ms`);
  }
}

export { ipcora, client, demoDestructuring };
