'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
process.env.SWU_SESSION_SECRET ||= randomBytes(32).toString('hex');

const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks, assertPrivateView } = require('../scripts/smoke.cjs');
const decks = readDecks();
const seats = ['human', 'bot'];

async function checkpoint(record, game) {
  const token = sealRecord(record);
  assert.equal(typeof token, 'string');
  assert.ok(token.length < 300_000, 'An entire game remains practical to send with an API request.');
  assert.ok(!token.includes(record.deckId), 'The client session cannot expose deck recipes or random seeds.');
  const started = performance.now();
  const restored = await restoreRecord(token, { decks });
  const elapsed = performance.now() - started;
  try {
    assert.equal(restored.record.id, record.id);
    assert.deepEqual(restored.record.actions, record.actions);
    assert.deepEqual(restored.record.memory, JSON.parse(JSON.stringify(record.memory)), 'Bot plans and anti-loop memory survive another function instance.');
    assert.deepEqual(restored.record.botHistory, record.botHistory);
    for (const seat of seats) {
      assertPrivateView(restored.game.view(seat));
      assert.deepEqual(restored.game.canonicalView(seat), game.canonicalView(seat), `${seat} observes identical rules, cards and legal choices after replay.`);
    }
    assert.ok(elapsed < 20_000, `A cold session rebuild took ${Math.round(elapsed)}ms, beyond an interactive response budget.`);
    return { elapsed, bytes: Buffer.byteLength(token) };
  } finally { restored.game.close(); }
}

function coldProcessCheckpoint(record, game) {
  const started = performance.now();
  const child = spawnSync(process.execPath, ['-e', `
    const { restoreRecord } = require('./server/replay.cjs');
    const { readDecks } = require('./scripts/smoke.cjs');
    const token = require('node:fs').readFileSync(0, 'utf8');
    restoreRecord(token, { decks: readDecks() }).then(({ record, game }) => {
      process.stdout.write(JSON.stringify({ id: record.id, views: ['human', 'bot'].map(seat => game.canonicalView(seat)) }));
      game.close();
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), input: sealRecord(record), encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024, timeout: 25_000, env: { ...process.env } });
  const elapsed = performance.now() - started;
  assert.equal(child.status, 0, `Cold replay failed: ${child.error?.message || child.stderr}`);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.id, record.id);
  assert.deepEqual(restored.views, JSON.parse(JSON.stringify(seats.map(seat => game.canonicalView(seat)))), 'A completely new process reconstructs the late-game state.');
  assert.ok(elapsed < 25_000, `Cold start plus late-game restore took ${Math.round(elapsed)}ms.`);
  return elapsed;
}

test('encrypted game sessions reject malformed, modified, expired and differently signed tokens', { timeout: 60_000 }, async () => {
  const { record, game } = await createRecord({ playerDeck: decks[0], botDeck: decks[1], difficulty: 'normal', seed: 9102 });
  try {
    const token = sealRecord(record);
    const offset = Math.floor(token.length / 2);
    const modified = token.slice(0, offset) + (token[offset] === 'A' ? 'B' : 'A') + token.slice(offset + 1);
    for (const invalid of ['', 'not.a.session', modified]) {
      await assert.rejects(() => restoreRecord(invalid, { decks }), 'A bad authentication tag or malformed payload cannot restore a game.');
    }
    const differentDeployment = spawnSync(process.execPath, ['-e', `
      const { restoreRecord } = require('./server/replay.cjs');
      const { readDecks } = require('./scripts/smoke.cjs');
      const token = require('node:fs').readFileSync(0, 'utf8');
      restoreRecord(token, { decks: readDecks() }).then(({ game }) => {
        game.close(); process.exitCode = 1;
      }, () => { process.stdout.write('rejected'); });
    `], { cwd: path.resolve(__dirname, '..'), input: token, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, SWU_SESSION_SECRET: randomBytes(32).toString('hex') } });
    assert.equal(differentDeployment.status, 0, differentDeployment.stderr);
    assert.equal(differentDeployment.stdout, 'rejected', 'A token belongs to the deployment secret that created it.');
    const expiresAt = Date.now() + 1000;
    const shortLivedToken = sealRecord({ ...record, expiresAt });
    const realDateNow = Date.now;
    try {
      Date.now = () => expiresAt + 1;
      await assert.rejects(() => restoreRecord(shortLivedToken, { decks }), /expir|istek/i);
    } finally { Date.now = realDateNow; }
  } finally { game.close(); }
});

test('an illegal or stale action cannot enter the persisted replay history', { timeout: 30_000 }, async () => {
  const { record, game } = await createRecord({ playerDeck: decks[0], botDeck: decks[1], difficulty: 'normal', seed: 8113 });
  try {
    const view = seats.map(seat => game.view(seat)).find(candidate => candidate.legalActions.length);
    assert.ok(view);
    const legal = view.legalActions[0];
    const before = JSON.stringify(record);
    assert.throws(() => applyAction(record, game, { ...legal, promptId: 'stale-prompt' }, view.viewerId));
    assert.equal(JSON.stringify(record), before);
    applyAction(record, game, { ...legal, version: view.version }, view.viewerId);
    assert.equal(record.actions.length, 1);
    const after = JSON.stringify(record);
    assert.throws(() => applyAction(record, game, { ...legal, version: view.version }, view.viewerId));
    assert.equal(JSON.stringify(record), after);
    await checkpoint(record, game);
  } finally { game.close(); }
});

test('all 18 starters rebuild identical midgame and final states on a fresh server instance', { timeout: 240_000 }, async t => {
  assert.equal(decks.length, 18);
  const coveredActions = new Set();
  for (let index = 0; index < decks.length; index++) {
    await t.test(decks[index].id, async () => {
      const { record, game } = await createRecord({
        playerDeck: decks[index], botDeck: decks[(index + 1) % decks.length], difficulty: 'normal', seed: 101,
      });
      const humanMemory = {};
      let actions = 0;
      let midgame;
      try {
        while (actions < 700) {
          const views = seats.map(seat => game.view(seat));
          if (views[0].ended || views[0].winnerIds.length) break;
          const view = views.find(candidate => candidate.prompt?.active && candidate.legalActions.length);
          assert.ok(view, 'At least one player must have a legal decision before the game ends.');
          const decision = chooseAction(view, { difficulty: record.difficulty, memory: view.viewerId === 'bot' ? record.memory : humanMemory });
          assert.ok(decision.action, `The bot resolves ${view.prompt.title}.`);
          coveredActions.add(decision.action.type);
          applyAction(record, game, decision.action, view.viewerId);
          if (view.viewerId === 'bot') {
            record.botHistory.push({ action: decision.action.type, reason: decision.reason, score: decision.score });
            if (record.botHistory.length > 12) record.botHistory.shift();
          }
          actions++;
          if (actions === 40) midgame = await checkpoint(record, game);
        }
        assert.ok(game.view('human').winnerIds.length, `${decks[index].id} finishes within 700 actions.`);
        assert.ok(midgame, 'The replay test exercises real gameplay after setup.');
        assert.equal(record.actions.length, actions);
        const final = await checkpoint(record, game);
        t.diagnostic(`${decks[index].id}: ${actions} actions; final restore ${Math.round(final.elapsed)}ms; token ${final.bytes} bytes`);
        if (decks[index].id === 'lof-darth-maul') {
          t.diagnostic(`A fresh Node process rebuilt the late game in ${Math.round(coldProcessCheckpoint(record, game))}ms.`);
        }
      } finally { game.close(); }
    });
  }
  for (const type of ['card', 'button', 'perCard', 'stateful']) {
    assert.ok(coveredActions.has(type), `The matrix must replay real ${type} actions.`);
  }
});
