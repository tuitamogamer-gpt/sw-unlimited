'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAccountStore, createMemoryAccountAdapter, createFileAccountAdapter, createSupabaseAccountAdapter, MAX_DECKS, MAX_MATCHES } = require('../server/account-store.cjs');
const owner = `google_${'a'.repeat(64)}`;
const other = 'supabase_12345678-1234-1234-1234-123456789abc';
const preferences = (expectedVersion, value) => ({ kind: 'preferences', expectedVersion, value });

test('independent device edits merge atomically while conflicting edits return the winning snapshot', async () => {
  const adapter = createMemoryAccountAdapter();
  const first = createAccountStore({ adapter }); const second = createAccountStore({ adapter });
  await Promise.all([
    first.update(owner, [preferences(0, { difficulty: 'easy' })]),
    second.update(owner, [{ kind: 'training', expectedVersion: 0, value: { completedLessonIds: ['resources'] } }]),
  ]);
  const merged = await first.read(owner);
  assert.equal(merged.revision, 2);
  assert.equal(merged.preferences.value.difficulty, 'easy');
  assert.deepEqual(merged.training.value.completedLessonIds, ['resources']);
  const race = await Promise.allSettled([
    first.update(owner, [preferences(1, { difficulty: 'normal' })]),
    second.update(owner, [preferences(1, { difficulty: 'hard' })]),
  ]);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  const failed = race.find(item => item.status === 'rejected').reason;
  assert.equal(failed.status, 409); assert.equal(failed.code, 'ACCOUNT_CONFLICT');
  assert.equal(failed.snapshot.preferences.version, 2);
  assert.deepEqual(failed.snapshot, await second.read(owner));
  assert.equal((await first.read(other)).revision, 0, 'A different authenticated account starts with separate data.');
});

test('a stale batch applies nothing and deck tombstones prevent old devices from resurrecting deletes', async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const id = `custom-${'1'.repeat(24)}`;
  await store.update(owner, [{ kind: 'deck', id, expectedVersion: 0, value: { name: 'Rebels' } }, preferences(0, { compact: true })]);
  await store.update(owner, [{ kind: 'deck', id, expectedVersion: 1, value: null }]);
  await assert.rejects(store.update(owner, [preferences(1, { compact: false }), { kind: 'deck', id, expectedVersion: 0, value: { name: 'Old Rebels' } }]), { status: 409 });
  const latest = await store.read(owner);
  assert.equal(latest.preferences.value.compact, true);
  assert.equal(latest.decks[0].version, 2);
  assert.equal(latest.decks[0].deleted, true);
  assert.equal(latest.decks[0].value, null);
  await store.update(owner, [{ kind: 'deck', id, expectedVersion: 2, value: { name: 'Explicitly restored' } }]);
  assert.equal((await store.read(owner)).decks[0].value.name, 'Explicitly restored');
});

test('same-game checkpoints cannot roll back turns even when a device fetched the latest account version', async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const value = { gameId: '11111111-1111-1111-1111-111111111111', actionCount: 12 };
  await store.update(owner, [{ kind: 'currentGame', expectedVersion: 0, value }]);
  await assert.rejects(store.update(owner, [{ kind: 'currentGame', expectedVersion: 1, value: { ...value, actionCount: 11 } }]), { status: 409 });
  assert.equal((await store.read(owner)).currentGame.value.actionCount, 12);
});

test('removed match history keeps tombstones, blocks stale resurrection and releases active-match quota', async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const idAt = index => `${index.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`;
  const match = index => ({ kind: 'match', id: idAt(index), expectedVersion: 0, value: { gameId: idAt(index), outcome: 'human' } });
  await store.update(owner, Array.from({ length: MAX_MATCHES }, (_, index) => match(index)));
  await assert.rejects(store.update(owner, [match(MAX_MATCHES)]), { status: 413, code: 'ACCOUNT_QUOTA' });
  await store.update(owner, [{ kind: 'match', id: idAt(0), expectedVersion: 1, value: null }]);
  const removed = (await store.read(owner)).matches.find(item => item.id === idAt(0));
  assert.equal(removed.deleted, true); assert.equal(removed.version, 2);
  await assert.rejects(store.update(owner, [match(0)]), { status: 409, code: 'ACCOUNT_CONFLICT' });
  await store.update(owner, [match(MAX_MATCHES)]);
  const latest = await store.read(owner);
  assert.equal(latest.matches.filter(item => !item.deleted).length, MAX_MATCHES);
  assert.equal(latest.matches.length, MAX_MATCHES + 1, 'Tombstones retain item versions without consuming active history slots.');
});

test('native lesson progress unions verified completions after a concurrent device rebase', async () => {
  const adapter = createMemoryAccountAdapter();
  const first = createAccountStore({ adapter }); const second = createAccountStore({ adapter });
  const completed = (id, expectedVersion) => ({ kind: 'training', expectedVersion, value: { completedLessonIds: [id] } });
  const race = await Promise.allSettled([
    first.update(owner, [completed('resources', 0)]), second.update(owner, [completed('space-ambush', 0)]),
  ]);
  const winning = await first.read(owner);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  const missedLesson = winning.training.value.completedLessonIds.includes('resources') ? 'space-ambush' : 'resources';
  await second.update(owner, [completed(missedLesson, winning.training.version)]);
  assert.deepEqual(new Set((await first.read(owner)).training.value.completedLessonIds), new Set(['resources', 'space-ambush']));
  await first.update(owner, [completed('leader-deploy', 2)]);
  assert.equal((await second.read(owner)).training.value.completedLessonIds.length, 3);
});

test('cloud limits reject the whole transaction and arbitrary save keys/owners are rejected', async () => {
  const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
  const operations = Array.from({ length: MAX_DECKS + 1 }, (_, index) => ({ kind: 'deck', id: `custom-${index.toString(16).padStart(24, '0')}`, expectedVersion: 0, value: { name: `Deck ${index}` } }));
  await assert.rejects(store.update(owner, operations), { status: 413, code: 'ACCOUNT_QUOTA' });
  assert.equal((await store.read(owner)).revision, 0);
  for (const invalid of ['guest', '../google_fake', 'supabase_../other']) await assert.rejects(store.read(invalid), { status: 401 });
  for (const invalid of [[], [preferences(-1, {})], [preferences(0, {}), preferences(0, {})], [{ kind: '__proto__', expectedVersion: 0, value: {} }], [{ ...preferences(0, {}), ownerId: other }]]) {
    await assert.rejects(store.update(owner, invalid), { status: 400 });
  }
});

test('separate local file adapter instances safely merge and survive a fresh store instance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swu-account-store-'));
  try {
    const first = createAccountStore({ adapter: createFileAccountAdapter({ directory }) });
    const second = createAccountStore({ adapter: createFileAccountAdapter({ directory }) });
    await Promise.all([first.update(owner, [preferences(0, { compact: true })]), second.update(owner, [{ kind: 'training', expectedVersion: 0, value: { completedLessonIds: ['resources'] } }])]);
    const restored = await createAccountStore({ adapter: createFileAccountAdapter({ directory }) }).read(owner);
    assert.equal(restored.revision, 2); assert.equal(restored.preferences.value.compact, true);
    assert.deepEqual(restored.training.value.completedLessonIds, ['resources']);
    assert.equal((await fs.stat(path.join(directory, `${owner}.json`))).mode & 0o777, 0o600);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Supabase adapter sends server-owned identity filters and uses atomic RPC revisions across workers', async () => {
  const rows = new Map(); const requests = [];
  const secret = 'server-only-service-role-for-test';
  const fetcher = async (url, options) => {
    requests.push({ url: new URL(url), options });
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.headers.apikey, secret);
    if (options.method === 'GET') {
      const id = new URL(url).searchParams.get('owner_id').slice(3);
      const saved = rows.get(id);
      return Response.json(saved ? [{ revision: saved.revision, document: saved.document }] : []);
    }
    const { p_owner_id, p_expected_revision, p_document } = JSON.parse(options.body);
    const saved = rows.get(p_owner_id);
    if ((saved?.revision ?? null) !== p_expected_revision) return Response.json(false);
    rows.set(p_owner_id, { revision: (saved?.revision || 0) + 1, document: p_document });
    return Response.json(true);
  };
  const factory = () => createAccountStore({ adapter: createSupabaseAccountAdapter({ url: 'https://example.supabase.co', key: secret, fetcher }) });
  await Promise.all([factory().update(other, [preferences(0, { showLog: true })]), factory().update(other, [{ kind: 'training', expectedVersion: 0, value: { completedLessonIds: ['leader-deploy'] } }])]);
  const result = await factory().read(other);
  assert.equal(result.revision, 2); assert.equal(result.preferences.value.showLog, true);
  assert.deepEqual(result.training.value.completedLessonIds, ['leader-deploy']);
  assert.ok(requests.every(request => request.url.origin === 'https://example.supabase.co'));
  assert.ok(requests.some(request => request.url.pathname === '/rest/v1/rpc/swu_compare_account_save'));
  const unavailable = createSupabaseAccountAdapter({ url: 'https://example.supabase.co', key: secret, fetcher: async () => Response.json({ error: secret }, { status: 401 }) });
  await assert.rejects(unavailable.read(owner), error => error.status === 503 && !error.message.includes(secret));
});
