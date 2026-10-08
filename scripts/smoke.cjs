'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const SEATS = ['human', 'bot'];
const HIDDEN_KEYS = new Set(['hidden', 'exhausted', 'ownerId', 'controllerId', 'zone']);

function readDecks() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/decks.json'), 'utf8'));
  const decks = Array.isArray(raw) ? raw : raw.decks;
  assert.ok(Array.isArray(decks) && decks.length >= 2, 'At least two real starter decks must be imported.');
  return decks;
}

function assertPrivateView(view) {
  assert.ok(SEATS.includes(view.viewerId), 'The observation belongs to a known seat.');
  for (const key of ['seed', 'rng', 'randomSeed', 'game', 'engine']) {
    assert.equal(Object.hasOwn(view, key), false, `Private engine field ${key} must not be exposed.`);
  }
  const opponent = view.players[view.viewerId === 'human' ? 'bot' : 'human'];
  for (const key of ['deck', 'drawDeck', 'library', 'deckOrder']) {
    assert.equal(Object.hasOwn(opponent, key), false, `Opponent ${key} must not be exposed.`);
  }
  function visit(value, location) {
    if (!value || typeof value !== 'object') return;
    if (value.hidden === true) {
      for (const key of Object.keys(value)) assert.ok(HIDDEN_KEYS.has(key), `${location} leaks hidden-card field ${key}.`);
    }
    if (value.deployed && value.backImage) assert.equal(value.image, value.backImage, `${location} must show the deployed leader face.`);
    for (const [key, child] of Object.entries(value)) visit(child, `${location}.${key}`);
  }
  visit(view, 'view');
  for (const player of Object.values(view.players)) {
    const units = [...player.ground, ...player.space];
    const arenaIds = new Set(units.map(card => card.uuid));
    assert.equal(arenaIds.size, units.length, 'A physical unit may appear only once across the arenas.');
    for (const unit of units) {
      assert.ok(!/upgrade/i.test(unit.type || ''), `${unit.name}: attached upgrades cannot be standalone arena combatants.`);
      for (const upgrade of unit.upgrades || []) {
        assert.ok(!arenaIds.has(upgrade.uuid), `${upgrade.name}: an attached card must not also appear as an arena combatant.`);
      }
    }
  }
  assert.equal(opponent.hand.length, opponent.handCount);
  assert.equal(opponent.resources.length, opponent.resourceCount);
}

function publicTrace(view, decision) {
  return {
    version: view.version, round: view.round, seat: view.viewerId,
    phase: view.phase, prompt: view.prompt?.title, promptType: view.prompt?.type,
    action: decision?.action?.label || decision?.action?.type,
    reason: decision?.reason,
    bases: SEATS.map(id => ({ seat: id, damage: view.players[id].base.damage, hp: view.players[id].base.hp })),
  };
}

async function runGame({ playerDeck, botDeck, seed, difficulty = 'normal', maxActions = 2000, assertPrivacy = true, beforeSubmit }) {
  const { createGame } = require('../server/engine.cjs');
  const { chooseAction } = require('../server/bot.cjs');
  const session = await createGame({ playerDeck, botDeck, seed, difficulty });
  const memories = { human: {}, bot: {} };
  const trace = [];
  const promptCounts = {};
  const actionCounts = {};
  const repeatedPositions = new Map();
  const started = performance.now();
  let actions = 0;
  let decisionsMs = 0;
  let highestDecisionMs = 0;
  let maxAttachedCards = 0;
  try {
    while (actions < maxActions) {
      const views = SEATS.map(seat => session.view(seat));
      if (assertPrivacy) views.forEach(assertPrivateView);
      maxAttachedCards = Math.max(maxAttachedCards, ...views.map(view => Object.values(view.players)
        .flatMap(player => [...player.ground, ...player.space]).reduce((sum, unit) => sum + (unit.upgrades?.length || 0), 0)));
      if (views[0].ended || views[0].winnerIds.length) {
        assert.ok(views[0].winnerIds.length, 'A completed game must report at least one winner.');
        assert.deepEqual(views[0].winnerIds, views[1].winnerIds);
        return {
          playerDeck: playerDeck.id, botDeck: botDeck.id, seed, difficulty,
          actions, rounds: views[0].round, winnerIds: views[0].winnerIds,
          durationMs: Math.round(performance.now() - started),
          decisionsMs: Math.round(decisionsMs), highestDecisionMs: Math.round(highestDecisionMs),
          promptCounts, actionCounts, maxAttachedCards, finalBases: publicTrace(views[0]).bases,
        };
      }
      const view = views.find(candidate => candidate.prompt?.active && candidate.legalActions.length);
      assert.ok(view, `Neither seat has a legal action in round ${views[0].round}, phase ${views[0].phase}.`);
      assert.ok(view.round <= 100, 'A game exceeded 100 rounds without a result.');
      if (view.prompt.type === 'actionWindow') {
        const key = createHash('sha256').update(JSON.stringify({
          round: view.round, seat: view.viewerId, players: view.players,
          initiative: view.initiativePlayerId, claimed: view.initiativeClaimed,
          actions: view.legalActions.map(({ promptId, ...action }) => action),
        })).digest('hex');
        const visits = (repeatedPositions.get(key) || 0) + 1;
        repeatedPositions.set(key, visits);
        assert.ok(visits < 16, 'The same public action position repeated 16 times without progress.');
      }
      const decisionStarted = performance.now();
      const decision = await chooseAction(view, { difficulty, memory: memories[view.viewerId] });
      const elapsed = performance.now() - decisionStarted;
      decisionsMs += elapsed;
      highestDecisionMs = Math.max(highestDecisionMs, elapsed);
      assert.ok(decision?.action, `The bot returned no action for ${view.prompt.title}.`);
      assert.equal(decision.action.promptId, view.prompt.id, 'A bot action must target its current prompt.');
      trace.push(publicTrace(view, decision));
      if (trace.length > 24) trace.shift();
      promptCounts[view.prompt.type] = (promptCounts[view.prompt.type] || 0) + 1;
      actionCounts[decision.action.type] = (actionCounts[decision.action.type] || 0) + 1;
      if (beforeSubmit) await beforeSubmit({ session, view, decision });
      const next = await session.submit(decision.action, view.viewerId);
      assert.ok(next.version > view.version, 'A submitted legal action must advance the session revision.');
      actions++;
    }
    throw new Error(`Action limit (${maxActions}) reached without a completed game.`);
  } catch (error) {
    error.smokeContext = {
      playerDeck: playerDeck.id, botDeck: botDeck.id, seed, difficulty, actions,
      recentActions: trace,
      observations: SEATS.map(seat => {
        try {
          const view = session.view(seat);
          return { ...publicTrace(view), prompt: view.prompt, legalActions: view.legalActions, log: view.log.slice(-12) };
        } catch (inner) { return { seat, error: inner.message }; }
      }),
    };
    throw error;
  } finally {
    session.close();
  }
}

async function runMatrix({ decks = readDecks(), seeds = [101, 202], onResult = () => {}, maxActions = 2000 } = {}) {
  const results = [];
  for (let index = 0; index < decks.length; index++) {
    for (const [seedIndex, seed] of seeds.entries()) {
      const opponent = decks[(index + 1 + seedIndex) % decks.length];
      const result = await runGame({ playerDeck: decks[index], botDeck: opponent, seed, maxActions });
      results.push(result);
      onResult(result);
    }
  }
  return results;
}

async function main() {
  const { listDeckStatus } = require('../server/engine.cjs');
  const decks = readDecks();
  const status = await listDeckStatus(decks);
  const supported = status.filter(deck => deck.playable ?? deck.supported);
  const unsupported = status.filter(deck => !(deck.playable ?? deck.supported));
  const seeds = (process.env.SWU_SMOKE_SEEDS || '101,202').split(',').map(Number);
  assert.ok(seeds.every(Number.isSafeInteger), 'SWU_SMOKE_SEEDS must contain integer seeds.');
  const report = {
    testedAt: new Date().toISOString(), importedDecks: decks.length,
    executableDecks: supported.length,
    uniqueRegisteredCards: new Set(decks.flatMap(deck => [deck.leader.id, deck.base.id, ...deck.deck.map(card => card.id)])).size,
    inputSha256: Object.fromEntries(['data/decks.json', 'server/engine.cjs', 'server/bot.cjs',
      'vendor/forceteki/server/game/core/gameSteps/abilityWindow/TriggerWindowBase.ts'].map(file => [
      file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex'),
    ])),
    unsupported: unsupported.map(deck => ({ id: deck.id, error: deck.error, cards: deck.unsupportedCards })),
    seeds, results: [], passed: false,
  };
  const reportPath = path.resolve(process.env.SWU_SMOKE_REPORT || path.join(ROOT, 'docs/validation-smoke.json'));
  try {
    assert.equal(unsupported.length, 0, `Unsupported starters: ${unsupported.map(deck => deck.id).join(', ')}`);
    await runMatrix({ decks, seeds, maxActions: Number(process.env.SWU_SMOKE_MAX_ACTIONS || 2000), onResult(result) {
      report.results.push(result);
      console.log(`${result.playerDeck} vs ${result.botDeck} · seed ${result.seed} · ${result.rounds} rounds / ${result.actions} actions · ${result.winnerIds.join(',')}`);
    } });
    report.passed = true;
    report.totalActions = report.results.reduce((sum, result) => sum + result.actions, 0);
    console.log(`PASS: ${report.results.length} complete games, ${decks.length} starter decks, ${report.totalActions} legal actions. Hidden-card redaction checked at every decision.`);
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack, context: error.smokeContext };
    process.exitCode = 1;
    console.error(error.message);
    if (error.smokeContext) console.error(JSON.stringify(error.smokeContext, null, 2));
  } finally {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${reportPath}`);
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { readDecks, assertPrivateView, runGame, runMatrix };
