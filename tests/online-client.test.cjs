'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/online-client.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, filename);
const { createOnlineClient, ROOM_KEY, parseInvitation } = compiled.exports;
const disk = () => { const data = new Map(); return { data, getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
const deck = { id: 'sor-luke-skywalker' };
const response = data => new Response(JSON.stringify(data));

test('a lost create response preserves private access and retries the identical room after reload', async () => {
  const storage = disk(); let sent;
  const first = createOnlineClient({ storage, fetcher: async (path, options) => {
    sent = JSON.parse(options.body);
    assert.equal(path, '/api/rooms');
    assert.equal(JSON.parse(storage.getItem(ROOM_KEY)).playerKey, sent.playerKey, 'Persist before network submission.');
    throw new Error('lost response');
  } });
  await assert.rejects(first.create(deck), /Connection interrupted/);
  const restored = createOnlineClient({ storage, fetcher: async (path, options) => {
    assert.equal(path, '/api/rooms'); assert.deepEqual(JSON.parse(options.body), sent);
    return response({ room: { id: sent.id, revision: 0, status: 'waiting' } });
  } });
  await restored.resume();
  assert.equal(JSON.parse(storage.getItem(ROOM_KEY)).pending, undefined);
  const link = restored.invitation('https://game.example');
  assert.deepEqual(parseInvitation(link), { id: sent.id, inviteKey: sent.inviteKey });
  assert.ok(!link.includes(sent.playerKey)); assert.notEqual(sent.playerKey, sent.inviteKey);
  assert.deepEqual([...storage.data.keys()], [ROOM_KEY], 'Solo and cloud saves are untouched.');
});

test('joining journals a different player key and never publishes either player credential', async () => {
  const hostStorage = disk(), guestStorage = disk(); let hostKey, guestKey;
  const host = createOnlineClient({ storage: hostStorage, fetcher: async (_path, options) => {
    const body = JSON.parse(options.body); hostKey = body.playerKey; return response({ room: { id: body.id } });
  } });
  await host.create(deck); const invite = parseInvitation(host.invitation('https://game.example'));
  const guest = createOnlineClient({ storage: guestStorage, fetcher: async (path, options) => {
    assert.equal(path, `/api/rooms/${invite.id}/join`); const body = JSON.parse(options.body);
    guestKey = body.playerKey; assert.equal(body.inviteKey, invite.inviteKey); return response({ room: { id: invite.id } });
  } });
  await guest.join(deck, invite);
  assert.notEqual(hostKey, guestKey); assert.notEqual(guestKey, invite.inviteKey);
  assert.equal(guest.invitation('https://game.example'), '');
  await assert.rejects(guest.create(deck), /current room/);
  for (const bad of ['', 'https://bad.example', invite.id, '#join=' + invite.id + '.short']) assert.equal(parseInvitation(bad), null);
});

test('an interrupted move is sent once, and reconnect only reads the authoritative position', async () => {
  const storage = disk(); let requests = [], fail = false;
  const client = createOnlineClient({ storage, fetcher: async (path, options) => {
    requests.push({ path, options });
    const body = options.body && JSON.parse(options.body);
    if (fail && path.endsWith('/actions')) throw new Error('lost acknowledgement');
    return response({ room: { id: body?.id || JSON.parse(storage.getItem(ROOM_KEY)).id, revision: fail ? 3 : 0 }, game: { version: 2 } });
  } });
  const state = await client.create(deck); fail = true; requests = [];
  await assert.rejects(client.act(state, { type: 'button', promptId: 'native', arg: 'keep', label: 'UI only', method: 'menuButton' }));
  const restored = await client.resume(); assert.equal(restored.room.revision, 3);
  assert.equal(requests.length, 2); assert.equal(requests[1].options.method, 'GET');
  const posted = JSON.parse(requests[0].options.body);
  assert.deepEqual(posted.action, { type: 'button', promptId: 'native', arg: 'keep', version: 2 });
  assert.equal(posted.revision, 0); assert.match(posted.requestId, /^[a-f0-9-]{36}$/);
});

test('unavailable local storage keeps a seat in memory and reports that refresh is unsafe', async () => {
  const storage = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  const client = createOnlineClient({ storage, fetcher: async (_path, options) => response({ room: { id: JSON.parse(options.body).id } }) });
  await client.create(deck); assert.equal(client.hasSeat(), true); assert.equal(client.isPersistent(), false);
  assert.ok(parseInvitation(client.invitation('https://game.example')));
});
