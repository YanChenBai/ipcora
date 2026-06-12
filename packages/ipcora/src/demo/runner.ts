/**
 * Demo runner — exercises every Ipcora feature via 16 scenarios.
 *
 * Run directly:
 *   npx tsx src/demo/runner.ts
 */

import { createAppIpcora } from './ipcora';

export async function runDemo() {
  console.log('═'.repeat(60));
  console.log('  Ipcora Full-Featured Demo');
  console.log('═'.repeat(60));

  const { ipc, invoke, state } = createAppIpcora({ exposeStack: false });
  const ch = ipc.channel;

  // ---- Helpers ------------------------------------------------------------

  const uid = (() => {
    let n = 0;
    return () => `demo-${++n}`;
  })();

  const adminMeta = {
    traceId: 'trace-admin',
    user: { id: 'admin-1', role: 'admin' },
  };

  const memberMeta = {
    traceId: 'trace-member',
    user: { id: 'user-2', role: 'member' },
  };

  // ---- 1. Create a user (admin) ─────────────────────────────────────────
  console.log('\n── 1. user.create (admin) ──');
  const r1 = await invoke(ch, 1, {
    id: uid(),
    path: 'user.create',
    params: { name: 'Alice', email: '  alice@acme.com  ' }, // whitespace trimmed by onTransform
    metadata: adminMeta,
  });
  console.log('  result:', r1.data ?? r1.error);

  // ---- 2. Create user (member → forbidden) ──────────────────────────────
  console.log('\n── 2. user.create (member) ──');
  const r2 = await invoke(ch, 1, {
    id: uid(),
    path: 'user.create',
    params: { name: 'Eve', email: 'eve@acme.com' },
    metadata: memberMeta,
  });
  console.log('  result:', r2.error);

  // ---- 3. Get user ──────────────────────────────────────────────────────
  console.log('\n── 3. user.get ──');
  const r3 = await invoke(ch, 1, {
    id: uid(),
    path: 'user.get',
    params: { id: 'acme-corp-u1' },
    metadata: memberMeta,
  });
  console.log('  result:', r3.data);

  // ---- 4. Get non-existent user ─────────────────────────────────────────
  console.log('\n── 4. user.get (not found) ──');
  const r4 = await invoke(ch, 1, {
    id: uid(),
    path: 'user.get',
    params: { id: 'nope' },
    metadata: memberMeta,
  });
  console.log('  result:', r4.error);

  // ---- 5. List users ────────────────────────────────────────────────────
  console.log('\n── 5. user.list ──');
  const r5 = await invoke(ch, 1, {
    id: uid(),
    path: 'user.list',
    metadata: memberMeta,
  });
  console.log('  result: total=', (r5.data as any)?.total);

  // ---- 6. Health check (no params) ──────────────────────────────────────
  console.log('\n── 6. system.health ──');
  const r6 = await invoke(ch, 1, { id: uid(), path: 'system.health' });
  console.log('  result:', r6.data);

  // ---- 7. Admin: stats (admin) ──────────────────────────────────────────
  console.log('\n── 7. admin.stats (admin) ──');
  const r7 = await invoke(ch, 1, {
    id: uid(),
    path: 'admin.stats',
    metadata: adminMeta,
  });
  console.log('  result:', r7.data);

  // ---- 8. Admin: stats (member → forbidden) ─────────────────────────────
  console.log('\n── 8. admin.stats (member) ──');
  const r8 = await invoke(ch, 1, {
    id: uid(),
    path: 'admin.stats',
    metadata: memberMeta,
  });
  console.log('  result:', r8.error);

  // ---- 9. Admin: dangerousOp ────────────────────────────────────────────
  console.log('\n── 9. admin.dangerousOp ──');
  const r9 = await invoke(ch, 1, {
    id: uid(),
    path: 'admin.dangerousOp',
    metadata: adminMeta,
  });
  console.log('  result:', r9.data);

  // ---- 10. Validation error (schema reject) ─────────────────────────────
  console.log('\n── 10. user.create (bad params) ──');
  const r10 = await invoke(ch, 1, {
    id: uid(),
    path: 'user.create',
    params: { name: '', email: 'not-an-email' },
    metadata: adminMeta,
  });
  console.log('  result:', r10.error);

  // ---- 11. Custom ValidationError via error() mapping ───────────────────
  console.log('\n── 11. db.simulateError (validation type) ──');
  const r11 = await invoke(ch, 1, {
    id: uid(),
    path: 'db.simulateError',
    params: { type: 'validation' },
  });
  console.log('  result:', r11.error);

  // ---- 12. Custom DatabaseError → onError rewrites ──────────────────────
  console.log('\n── 12. db.simulateError (database type) ──');
  const r12 = await invoke(ch, 1, {
    id: uid(),
    path: 'db.simulateError',
    params: { type: 'database' },
  });
  console.log('  result:', r12.error);

  // ---- 13. Unknown error → INTERNAL_SERVER_ERROR ────────────────────────
  console.log('\n── 13. db.simulateError (unknown type) ──');
  const r13 = await invoke(ch, 1, {
    id: uid(),
    path: 'db.simulateError',
    params: { type: 'unknown' },
  });
  console.log('  result:', r13.error);

  // ---- 14. Handler not found ────────────────────────────────────────────
  console.log('\n── 14. non-existent path ──');
  const r14 = await invoke(ch, 1, { id: uid(), path: 'nope.notHere' });
  console.log('  result:', r14.error);

  // ---- 15. Events ───────────────────────────────────────────────────────
  console.log('\n── 15. Events ──');
  await ipc.emit('userLogin', { userId: 'acme-corp-u1', at: Date.now() });

  // ---- 16. Route definition (type-level inspection) ─────────────────────
  console.log('\n── 16. Router type definition ──');
  console.log('  definition keys:', Object.keys(ipc.definition));

  // ---- Cleanup ──────────────────────────────────────────────────────────
  ipc.dispose();
  console.log('\n═'.repeat(60));
  console.log('  Demo complete.  16 scenarios exercised.');
  console.log('═'.repeat(60));

  return { ipc, state };
}

// ---- Self-execute when run directly ---------------------------------------

const isMainModule = typeof process !== 'undefined' && process.argv[1]?.includes('demo');

if (isMainModule) {
  runDemo().catch(err => {
    console.error('Demo failed:', err);
    process.exit(1);
  });
}
