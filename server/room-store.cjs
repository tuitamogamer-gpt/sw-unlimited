'use strict';

const ROOM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function roomError(status, code, message) {
  return Object.assign(new Error(message), { status, code, publicMessage: message });
}
function checkId(id) {
  if (typeof id !== 'string' || !ROOM_ID.test(id)) throw roomError(400, 'ROOM_INPUT', 'Invalid room link.');
}

// Test/local adapter only. Production never falls back to process-local rooms.
function createMemoryRoomAdapter() {
  const rows = new Map();
  return {
    async read(id) { checkId(id); return structuredClone(rows.get(id) || null); },
    async compareAndSwap(id, expectedRevision, value) {
      checkId(id);
      if ((rows.get(id)?.revision ?? null) !== expectedRevision) return false;
      rows.set(id, structuredClone(value)); return true;
    },
  };
}

function createSupabaseRoomAdapter({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, fetcher = fetch } = {}) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || !key) throw new TypeError('A server Supabase connection is required.');
  async function request(endpoint, body) {
    let response;
    try {
      response = await fetcher(new URL(endpoint, base), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 1100000) throw new Error(); chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw roomError(503, 'ROOM_STORAGE', 'Online play is temporarily unavailable. Try again shortly.'); }
  }
  return {
    async read(id) {
      checkId(id);
      const rows = await request(`/rest/v1/swu_rooms?${new URLSearchParams({ id: `eq.${id}`, select: 'document', limit: '1' })}`);
      if (!Array.isArray(rows) || rows.length > 1) throw roomError(503, 'ROOM_STORAGE', 'Online play is temporarily unavailable. Try again shortly.');
      return rows[0]?.document || null;
    },
    async compareAndSwap(id, expectedRevision, value) {
      checkId(id);
      const result = await request('/rest/v1/rpc/swu_compare_room', { p_id: id, p_expected_revision: expectedRevision, p_document: value });
      if (typeof result !== 'boolean') throw roomError(503, 'ROOM_STORAGE', 'Online play is temporarily unavailable. Try again shortly.');
      return result;
    },
  };
}
function environmentRoomAdapter() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try { return createSupabaseRoomAdapter(); } catch { return null; }
  }
  // Explicit opt-in for playing between browsers against a local development server.
  return !process.env.VERCEL && process.env.SWU_LOCAL_ROOMS === 'true' ? createMemoryRoomAdapter() : null;
}
module.exports = { createMemoryRoomAdapter, createSupabaseRoomAdapter, environmentRoomAdapter, roomError, checkId };
