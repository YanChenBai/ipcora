/**
 * Full-featured Ipcora router factory.
 *
 * Covers every Ipcora feature in a single, readable setup:
 *   state · decorate · derive · resolve
 *   onRequest · onTransform · onGuard · onBeforeHandle
 *   onAfterHandle · onMapResponse · onError · onAfterResponse
 *   use (middleware) · macro · error (mapping)
 *   group · events · handler (with params / output schemas)
 *   bind
 */

import { defineEventSchema } from '../event';
import { createIpcora, fail, type Ipcora } from '../index';
import { createMemoryAdapter, type MemoryAdapter } from './adapter';
import { ValidationError, DatabaseError } from './errors';
import {
  createUserParams,
  getUserParams,
  simulateErrorParams,
  userOutput,
  userLoginEvent,
} from './schemas';
import type { AppContext, AppState } from './types';

export interface AppIpcora {
  ipc: Ipcora<AppContext, AppState, any, any, any, any>;
  invoke: MemoryAdapter['invoke'];
  state: AppState;
  memory: MemoryAdapter;
}

export function createAppIpcora(opts?: { exposeStack?: boolean }): AppIpcora {
  const memory = createMemoryAdapter();

  const state: AppState = {
    users: new Map(),
    seq: 0,
  };

  // ====== Router ===========================================================

  const ipc = createIpcora<AppContext, AppState>({
    channel: 'app:ipc',
    adapter: memory.adapter,
    exposeStack: opts?.exposeStack,
  })
    // ── state: shared mutable data exposed as `store` ──────────────────
    .state(state)

    // ── decorate: static properties on every lifecycle value ───────────
    .decorate({ serviceName: 'user-service', version: '1.0.0' })

    // ── derive: runs BEFORE validation (raw request info) ──────────────
    .derive(({ rawParams, metadata }) => ({
      rawType: typeof rawParams,
      hasMetadata: metadata != null && Object.keys(metadata).length > 0,
    }))

    // ── onRequest: inspect the raw incoming request ────────────────────
    .onRequest(({ id, path }) => {
      console.log(`  [onRequest] id=${id} path=${path}`);
    })

    // ── onTransform: normalize params before validation ────────────────
    .onTransform(({ params }) => {
      if (params && typeof params === 'object') {
        const p = params as Record<string, unknown>;
        const trimmed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p)) {
          trimmed[k] = typeof v === 'string' ? (v as string).trim() : v;
        }
        return trimmed;
      }
    })

    // ── resolve: runs AFTER validation (derived from parsed params) ────
    .resolve(({ peer, metadata }) => ({
      requestId: `req-${metadata.traceId ?? 'no-trace'}-${peer.id}`,
      locale: 'zh-CN',
    }))

    // ── onGuard: global auth / role resolution ─────────────────────────
    .onGuard(({ metadata }) => {
      const user = (metadata as Record<string, unknown>).user as
        | { id: string; role: string }
        | undefined;
      return {
        currentUser: user,
        isAdmin: user?.role === 'admin',
      };
    })

    // ── use (middleware): timing tracer ────────────────────────────────
    .use<{ enteredAt: number }>((ctx, next) => {
      const now = Date.now();
      console.log(`  [mw:timing] enter path=${ctx.path}`);
      return next({ enteredAt: now });
    })

    // ── use (middleware): structured logger ────────────────────────────
    .use<{ logPrefix: string }>((ctx, next) => {
      const ts = new Date(ctx.startedAt).toISOString();
      console.log(`  [mw:log] [${ts}] ${ctx.path} — peer ${ctx.peer.id}`);
      return next({ logPrefix: `[${ctx.peer.id}:${ctx.id}]` });
    })

    // ── error: map custom Error classes to IpcError payloads ───────────
    .error(ValidationError, ({ fail, error }) =>
      fail('VALIDATION_CUSTOM', { message: error.message }),
    )
    .error(DatabaseError, ({ fail, error }) => fail('DB_UNAVAILABLE', { message: error.message }))

    // ── onError: global error observer / rewriter ──────────────────────
    .onError(({ name, phase, path }) => {
      console.log(`  [onError] name="${name}" phase="${phase}" path="${path}"`);
      if (name === 'DB_UNAVAILABLE') {
        return { error: { name, message: 'Database is temporarily unavailable' } };
      }
      // Returning undefined lets the default error response through.
    })

    // ── macro: reusable option `requireAdmin` ──────────────────────────
    .macro('requireAdmin', {
      onGuard({ isAdmin, fail }) {
        if (!isAdmin) {
          throw fail('FORBIDDEN', { message: 'Admin role required' });
        }
      },
    })

    // ── onBeforeHandle: shared guard (abort check) ─────────────────────
    .onBeforeHandle(({ signal }) => {
      if (signal.aborted) throw fail('ABORTED', { message: 'Request aborted' });
    })

    // ── onAfterHandle: wrap outputs with a timestamp ───────────────────
    .onAfterHandle(({ output }) => {
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        return { ...(output as object), _handledAt: Date.now() };
      }
    })

    // ── onMapResponse: final response shape transform ──────────────────
    .onMapResponse(({ response }) => {
      console.log(`  [onMapResponse] hasError=${!!response.error}`);
      // Could transform the response shape here; leave as-is for the demo.
    })

    // ── onAfterResponse: logging / metrics ─────────────────────────────
    .onAfterResponse(({ success, duration, path }) => {
      if (!success) {
        console.log(`  [onAfterResponse] FAIL path=${path} (${duration.toFixed(1)}ms)`);
      }
    })

    // ── events: typed event definitions ────────────────────────────────
    .events(
      defineEventSchema({
        userLogin: userLoginEvent,
      }),
    );

  // ====== Group: admin -------------------------------------------------------

  ipc.group('admin', admin => {
    return admin
      .use<{ adminAudit: true }>((ctx, next) => {
        console.log(`  [admin mw] path=${ctx.path}`);
        return next({ adminAudit: true });
      })

      .handler(
        'stats',
        ({ store }) => ({
          totalUsers: store.users.size,
          uptime: process.uptime(),
        }),
        { requireAdmin: true },
      )

      .handler('dangerousOp', ({ tenant }) => `Executed dangerous operation in tenant "${tenant}"`);
  });

  // ====== Handler: user.create (admin only, with schemas) --------------------

  ipc.handler(
    'user.create',
    ({ store, tenant, params }) => {
      store.seq += 1;
      const id = `${tenant}-u${store.seq}`;
      const record = {
        id,
        name: params.name,
        email: params.email,
        createdAt: Date.now(),
      };
      store.users.set(id, record);
      return record;
    },
    {
      params: createUserParams,
      output: userOutput,
      requireAdmin: true,
      onAfterHandle({ output }) {
        console.log(`  [user.create onAfterHandle] id=${(output as { id: string }).id}`);
      },
    },
  );

  // ====== Handler: user.get (public, with schema) ----------------------------

  ipc.handler(
    'user.get',
    ({ store, params }) => {
      const user = store.users.get(params.id);
      if (!user) {
        throw fail('NOT_FOUND', { message: `User "${params.id}" not found` });
      }
      return user;
    },
    {
      params: getUserParams,
      output: userOutput,
    },
  );

  // ====== Handler: user.list (public, no params) -----------------------------

  ipc.handler('user.list', ({ store, requestId }) => ({
    items: [...store.users.values()],
    total: store.users.size,
    requestId,
  }));

  // ====== Handler: system.health (no params) ---------------------------------

  ipc.handler('system.health', ({ serviceName, version, enteredAt, logPrefix }) => ({
    service: serviceName,
    version,
    uptime: Date.now() - enteredAt!,
    logPrefix,
  }));

  // ====== Handler: db.simulateError (custom error classes demo) ---------------

  ipc.handler(
    'db.simulateError',
    ({ params }) => {
      switch (params.type) {
        case 'validation':
          throw new ValidationError('Simulated validation failure');
        case 'database':
          throw new DatabaseError('Simulated database failure');
        case 'unknown':
          throw new Error('Simulated unknown error');
        default:
          return { ok: true, type: params.type };
      }
    },
    { params: simulateErrorParams },
  );

  // ====== Bind a peer ======================================================

  ipc.bind({ id: 1, sender: { id: 1 } }, { context: { tenant: 'acme-corp' } });

  return { ipc, invoke: memory.invoke, state, memory };
}

// Re-export the factory return type for consumers
export type { AppState, AppContext } from './types';
export { createMemoryAdapter } from './adapter';
