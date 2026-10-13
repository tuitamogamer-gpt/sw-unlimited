'use strict';

// A single account document is committed with compare-and-swap. Item versions
// allow independent device edits to merge without replacing unrelated saves.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ACCOUNT_ID = /^(?:google_[a-f0-9]{64}|supabase_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const MAX_ACCOUNT_BYTES = 5 * 1024 * 1024;
const MAX_OPERATIONS = 60;
const MAX_DECKS = 50;
const MAX_DECK_RECORDS = 200;
const MAX_MATCHES = 50;
const MAX_MATCH_RECORDS = 500;
const SINGLETONS = new Set(['preferences', 'currentGame', 'training']);
const KINDS = new Set([...SINGLETONS, 'deck', 'match']);
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function storeError(status, code, message, snapshot) {
  const error = new Error(message); Object.assign(error, { status, code, ...(snapshot ? { snapshot } : {}) }); return error;
}
function checkOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ACCOUNT_ID.test(ownerId)) throw storeError(401, 'ACCOUNT_REQUIRED', 'Sign in to use cloud saves.');
}
function emptyAccount() {
  const item = () => ({ version: 0, value: null, updatedAt: 0 });
  return { schema: 1, revision: 0, decks: {}, preferences: item(), currentGame: item(), matches: {}, training: item() };
}
function checkedDocument(value) {
  if (value === null || value === undefined) return emptyAccount();
  if (!object(value) || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !object(value.decks) || !object(value.matches)
    || !['preferences', 'currentGame', 'training'].every(key => object(value[key]) && Number.isSafeInteger(value[key].version))) {
    throw storeError(503, 'ACCOUNT_STORAGE_INVALID', 'Cloud saves are unavailable. Your local saves have been kept.');
  }
  return clone(value);
}
function snapshot(document) {
  return { enabled: true, revision: document.revision,
    decks: Object.entries(document.decks).map(([id, item]) => ({ id, ...clone(item), deleted: item.value === null })),
    preferences: clone(document.preferences), currentGame: clone(document.currentGame),
    matches: Object.entries(document.matches).map(([id, item]) => ({ id, ...clone(item), deleted: item.value === null })),
    training: clone(document.training) };
}
function operationKey(operation) {
  if (!object(operation) || !KINDS.has(operation.kind)
    || !Number.isSafeInteger(operation.expectedVersion) || operation.expectedVersion < 0
    || !Object.prototype.hasOwnProperty.call(operation, 'value')
    || operation.value !== null && !object(operation.value)
    || Object.keys(operation).some(key => !['kind', 'id', 'expectedVersion', 'value'].includes(key))) {
    throw storeError(400, 'ACCOUNT_INPUT', 'Invalid cloud save update.');
  }
  if (SINGLETONS.has(operation.kind)) {
    if (operation.id !== undefined) throw storeError(400, 'ACCOUNT_INPUT', 'Invalid cloud save key.');
    return operation.kind;
  }
  const validId = operation.kind === 'deck' ? /^custom-[a-f0-9]{24}$/ : /^[a-f0-9-]{36}$/i;
  if (typeof operation.id !== 'string' || !validId.test(operation.id)) throw storeError(400, 'ACCOUNT_INPUT', 'Invalid cloud save key.');
  return `${operation.kind}:${operation.id}`;
}
function checkOperations(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_OPERATIONS) {
    throw storeError(400, 'ACCOUNT_INPUT', `Send between 1 and ${MAX_OPERATIONS} cloud save updates.`);
  }
  const keys = new Set();
  for (const operation of operations) {
    const key = operationKey(operation);
    if (keys.has(key)) throw storeError(400, 'ACCOUNT_INPUT', 'A save key may only be updated once per request.');
    keys.add(key);
  }
}
function location(document, operation) {
  if (SINGLETONS.has(operation.kind)) return { container: document, key: operation.kind };
  return { container: document[operation.kind === 'deck' ? 'decks' : 'matches'], key: operation.id };
}
function checkQuota(document) {
  const decks = Object.values(document.decks);
  const matches = Object.values(document.matches);
  if (decks.filter(item => item.value !== null).length > MAX_DECKS || decks.length > MAX_DECK_RECORDS
    || matches.filter(item => item.value !== null).length > MAX_MATCHES || matches.length > MAX_MATCH_RECORDS
    || Buffer.byteLength(JSON.stringify(document)) > MAX_ACCOUNT_BYTES) {
    throw storeError(413, 'ACCOUNT_QUOTA', 'Cloud saves are full. Remove a saved deck or match, then try again.');
  }
}

function createAccountStore({ adapter, now = Date.now, attempts = 8 } = {}) {
  if (!adapter || typeof adapter.read !== 'function' || typeof adapter.compareAndSwap !== 'function') {
    throw new TypeError('An atomic account storage adapter is required.');
  }
  async function read(ownerId) {
    checkOwner(ownerId);
    const saved = await adapter.read(ownerId);
    return snapshot(checkedDocument(saved?.value));
  }
  async function update(ownerId, operations) {
    checkOwner(ownerId); checkOperations(operations);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const saved = await adapter.read(ownerId);
      const document = checkedDocument(saved?.value);
      for (const operation of operations) {
        const { container, key } = location(document, operation);
        if ((container[key]?.version || 0) !== operation.expectedVersion) {
          throw storeError(409, 'ACCOUNT_CONFLICT', 'A newer cloud save exists. Review it before replacing it.', snapshot(document));
        }
        if (operation.kind === 'currentGame' && operation.value?.gameId === container[key]?.value?.gameId
          && operation.value.actionCount < container[key].value.actionCount) {
          throw storeError(409, 'ACCOUNT_CONFLICT', 'A newer saved turn exists. Review it before replacing it.', snapshot(document));
        }
      }
      for (const operation of operations) {
        const { container, key } = location(document, operation);
        let value = clone(operation.value);
        if (operation.kind === 'training' && value !== null) {
          value = { completedLessonIds: [...new Set([...(container[key]?.value?.completedLessonIds || []), ...value.completedLessonIds])] };
        }
        container[key] = { version: operation.expectedVersion + 1, value, updatedAt: now() };
      }
      // Item tombstones retain their version. Active entries release quota
      // when deleted, while old devices cannot silently resurrect them.
      document.revision++;
      checkQuota(document);
      if (await adapter.compareAndSwap(ownerId, saved?.version ?? null, document)) return snapshot(document);
    }
    throw storeError(409, 'ACCOUNT_CONFLICT', 'Cloud saves changed during this request. Refresh and try again.', await read(ownerId));
  }
  return { read, update };
}

function createMemoryAccountAdapter() {
  const accounts = new Map();
  return {
    async read(ownerId) { checkOwner(ownerId); return accounts.has(ownerId) ? clone(accounts.get(ownerId)) : null; },
    async compareAndSwap(ownerId, expectedVersion, value) {
      checkOwner(ownerId);
      if ((accounts.get(ownerId)?.version ?? null) !== expectedVersion) return false;
      accounts.set(ownerId, { version: randomUUID(), value: clone(value) }); return true;
    },
  };
}

function createSupabaseAccountAdapter({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, fetcher = fetch } = {}) {
  let base;
  try {
    base = new URL(url);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))
      || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new Error('Invalid URL');
  } catch { throw new TypeError('A valid server Supabase project URL is required.'); }
  if (typeof key !== 'string' || key.length < 20) throw new TypeError('A server Supabase service-role key is required.');
  async function request(endpoint, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetcher(new URL(endpoint, base), { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { throw storeError(503, 'ACCOUNT_STORAGE_UNAVAILABLE', 'Cloud saves are unavailable. Your local saves have been kept.'); }
    if (!response.ok || !response.body) throw storeError(503, 'ACCOUNT_STORAGE_UNAVAILABLE', 'Cloud saves are unavailable. Your local saves have been kept.');
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ACCOUNT_BYTES + 4096) throw storeError(503, 'ACCOUNT_STORAGE_INVALID', 'Cloud saves are unavailable.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw storeError(503, 'ACCOUNT_STORAGE_INVALID', 'Cloud saves are unavailable.'); }
  }
  return {
    async read(ownerId) {
      checkOwner(ownerId);
      const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, select: 'revision,document', limit: '1' });
      const rows = await request(`/rest/v1/swu_account_saves?${query}`);
      if (!Array.isArray(rows) || rows.length > 1 || rows[0] && (!Number.isSafeInteger(rows[0].revision) || !object(rows[0].document))) {
        throw storeError(503, 'ACCOUNT_STORAGE_INVALID', 'Cloud saves are unavailable.');
      }
      return rows.length ? { version: rows[0].revision, value: rows[0].document } : null;
    },
    async compareAndSwap(ownerId, expectedVersion, value) {
      checkOwner(ownerId);
      const result = await request('/rest/v1/rpc/swu_compare_account_save', { method: 'POST',
        body: { p_owner_id: ownerId, p_expected_revision: expectedVersion, p_document: value } });
      if (typeof result !== 'boolean') throw storeError(503, 'ACCOUNT_STORAGE_INVALID', 'Cloud saves are unavailable.');
      return result;
    },
  };
}

// Explicit local-development adapter. Vercel must use durable remote storage;
// its ephemeral filesystem is never selected as a cloud-save fallback.
function createFileAccountAdapter({ directory } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Use an absolute local account storage directory.');
  const filename = ownerId => { checkOwner(ownerId); return path.join(directory, `${ownerId}.json`); };
  async function read(ownerId) {
    try { return JSON.parse(await fs.readFile(filename(ownerId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return { read, async compareAndSwap(ownerId, expectedVersion, value) {
    const target = filename(ownerId); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = `${target}.lock`;
    // mkdir is an inter-process lock, unlike a promise queue in one worker.
    let held = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.mkdir(lock, { mode: 0o700 }); held = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!held) throw storeError(503, 'ACCOUNT_STORAGE_BUSY', 'Cloud saves are busy. Try again.');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      if (((await read(ownerId))?.version ?? null) !== expectedVersion) return false;
      await fs.writeFile(temporary, JSON.stringify({ version: randomUUID(), value }), { mode: 0o600 });
      await fs.rename(temporary, target); return true;
    } finally { await fs.rm(temporary, { force: true }); await fs.rmdir(lock); }
  } };
}

module.exports = { createAccountStore, createMemoryAccountAdapter, createFileAccountAdapter, createSupabaseAccountAdapter,
  storeError, checkOwner, checkOperations, MAX_OPERATIONS, MAX_ACCOUNT_BYTES, MAX_DECKS, MAX_MATCHES };
