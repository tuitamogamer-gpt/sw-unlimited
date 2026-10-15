'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/public-data.ts');
const compiled = new Module(filename, module);
compiled.require = requested => requested === './game-client' ? { api() { throw new Error('Use an explicit test request'); } } : require(requested);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, filename);
const { createPublicDataClient } = compiled.exports;
const catalog = { decks: [{ id: 'luke', name: 'Luke starter', leader: { name: 'Luke Skywalker' } }], rulesVersion: 'pinned', sources: [{ url: 'https://starwarsunlimited.com' }] };
const training = { lessons: [{ id: 'resources', title: 'Resources', summary: 'Choose two cards.', duration: '1 minute' }] };

test('concurrent mounts and account changes reuse one public catalog request, with bounded freshness', async () => {
  let calls = 0, clock = 100, release;
  const first = new Promise(resolve => { release = resolve; });
  const data = createPublicDataClient({ request: async path => {
    assert.equal(path, '/api/decks');
    calls++;
    return calls === 1 ? first : catalog;
  }, now: () => clock, ttlMs: 10 });
  const guest = data.loadDecks(), signedIn = data.loadDecks();
  assert.equal(guest, signedIn);
  await Promise.resolve(); assert.equal(calls, 1);
  clock = 200; assert.equal(data.loadDecks(), guest, 'An in-flight request remains shared even after a slow network response.');
  release(catalog);
  assert.deepEqual(await signedIn, catalog);
  assert.deepEqual(await data.loadDecks(), catalog); assert.equal(calls, 1);
  clock += 11;
  assert.deepEqual(await data.loadDecks(), catalog); assert.equal(calls, 2);
});

test('failed and malformed catalogs are not cached, so Retry can recover', async () => {
  for (const initial of [new Error('offline'), { decks: null }, { decks: [null] },
    { decks: [{ ...catalog.decks[0], aspects: {} }] }, { decks: [{ ...catalog.decks[0], leader: { aspects: { bad: true } } }] }]) {
    let calls = 0;
    const data = createPublicDataClient({ request: async () => {
      calls++;
      if (calls === 1) { if (initial instanceof Error) throw initial; return initial; }
      return catalog;
    } });
    await assert.rejects(data.loadDecks());
    assert.deepEqual(await data.loadDecks(), catalog); assert.equal(calls, 2);
  }
});

test('training loads independently from decks and retries invalid lesson responses', async () => {
  let attempts = 0;
  const paths = [];
  const data = createPublicDataClient({ request: async path => {
    paths.push(path);
    if (path === '/api/decks') return catalog;
    return ++attempts === 1 ? { lessons: [{ ...training.lessons[0], duration: null }] } : training;
  } });
  const [decks, lessons] = await Promise.allSettled([data.loadDecks(), data.loadTraining()]);
  assert.equal(decks.status, 'fulfilled'); assert.equal(lessons.status, 'rejected');
  assert.deepEqual(await data.loadTraining(), training.lessons);
  assert.deepEqual(await data.loadDecks(), catalog);
  assert.deepEqual(paths, ['/api/decks', '/api/training', '/api/training']);
});

test('duplicate or empty lesson catalogs fail visibly instead of rendering a permanently empty grid', async () => {
  for (const value of [{ lessons: [] }, { lessons: [training.lessons[0], training.lessons[0]] }, { lessons: [{}] }]) {
    await assert.rejects(createPublicDataClient({ request: async () => value }).loadTraining(), /Training missions could not be loaded/);
  }
});
