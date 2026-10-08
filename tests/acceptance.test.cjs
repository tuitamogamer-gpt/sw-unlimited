'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createGame, listDeckStatus, loadCard } = require('../server/engine.cjs');
const { readDecks, assertPrivateView, runGame } = require('../scripts/smoke.cjs');

test('every imported retail starter contains 50 main cards and fully executable engine registrations', async () => {
  const decks = readDecks();
  assert.equal(new Set(decks.map(deck => deck.id)).size, decks.length, 'Starter IDs must be unique.');
  const statuses = await listDeckStatus(decks);
  for (const deck of decks) {
    assert.equal(deck.deck.reduce((sum, entry) => sum + entry.count, 0), 50, `${deck.id}: exact printed main-deck size`);
    assert.equal(new Set(deck.deck.map(entry => entry.id)).size, deck.deck.length, `${deck.id}: aggregate repeated card IDs`);
    for (const entry of deck.deck) assert.ok(Number.isInteger(entry.count) && entry.count >= 1 && entry.count <= 3, `${deck.id}: invalid count for ${entry.id}`);
    const status = statuses.find(item => item.id === deck.id);
    assert.equal(status.playable ?? status.supported, true, `${deck.id}: ${status.error || status.unsupportedCards?.map(card => card.name).join(', ')}`);
    assert.equal(status.unsupportedCards.length, 0, `${deck.id}: unsupported rules must not silently become playable.`);
    const leader = await loadCard(deck.leader.id);
    const base = await loadCard(deck.base.id);
    assert.ok(leader.types.some(type => /leader/i.test(type)), `${deck.id}: leader slot must be a leader.`);
    assert.ok(base.types.some(type => /base/i.test(type)), `${deck.id}: base slot must be a base.`);
  }
});

test('actual game observations redact hidden cards and illegal/stale human payloads leave state unchanged', async () => {
  const decks = readDecks();
  const session = await createGame({ playerDeck: decks[0], botDeck: decks[1], seed: 9981 });
  try {
    const human = session.view('human');
    const bot = session.botView();
    [human, bot].forEach(assertPrivateView);
    assert.deepEqual(bot, session.view('bot'));
    assert.ok(human.players.bot.hand.every(card => card.hidden), 'Opening enemy hand remains facedown.');
    assert.ok(bot.players.human.hand.every(card => card.hidden), 'The bot cannot inspect the human opening hand.');
    assert.ok(human.players.human.hand.every(card => !card.hidden && card.name), 'The human may inspect their own hand.');
    const active = [human, bot].find(view => view.legalActions.length);
    const seat = active.viewerId;
    const legal = active.legalActions[0];
    assert.ok(legal, 'Normal game setup has a legal decision.');
    const before = session.view(seat);
    const invalid = [
      { ...legal, promptId: 'forged-prompt' },
      { ...legal, version: before.version + 99 },
      { type: 'card', cardId: 'not-a-real-card', promptId: before.prompt.id },
      { type: 'button', arg: 'not-a-real-choice', promptId: before.prompt.id },
      { type: 'execute-code', promptId: before.prompt.id },
    ];
    for (const action of invalid) {
      assert.throws(() => session.submit(action, seat), /prompt|state|legal|action/i);
      assert.deepEqual(session.view(seat), before, 'Rejected actions must not mutate the real game.');
    }
    assert.throws(() => session.submit(legal, 'unknown-player'), /player/i);
    session.submit({ ...legal, version: before.version }, seat);
    assert.throws(() => session.submit({ ...legal, version: before.version }, seat), /prompt|state/i, 'Replaying an old payload must be rejected.');
    ['human', 'bot'].map(id => session.view(id)).forEach(assertPrivateView);
  } finally { session.close(); }
});

test('each available starter completes a real bot-versus-bot game without illegal actions or stalled prompts', { timeout: 300_000 }, async (t) => {
  const decks = readDecks();
  for (let index = 0; index < decks.length; index++) {
    const opponent = decks[(index + 1) % decks.length];
    await t.test(`${decks[index].id} versus ${opponent.id}`, async () => {
      try {
        const result = await runGame({ playerDeck: decks[index], botDeck: opponent, seed: 701 + index });
        assert.ok(result.actions > 10, 'A full game includes actual setup and gameplay decisions.');
        assert.ok(result.winnerIds.length > 0);
        t.diagnostic(`${result.actions} legal actions; ${result.rounds} rounds; winner ${result.winnerIds.join(',')}`);
      } catch (error) {
        if (error.smokeContext) t.diagnostic(JSON.stringify(error.smokeContext));
        throw error;
      }
    });
  }
});

test('Jabba does not repeat an unaffordable play ability indefinitely', { timeout: 30_000 }, async () => {
  const decks = readDecks();
  const result = await runGame({
    playerDeck: decks.find(deck => deck.id === 'law-jabba-the-hutt'),
    botDeck: decks.find(deck => deck.id === 'ash-emperor-palpatine'),
    seed: 101, maxActions: 600,
  });
  assert.ok(result.winnerIds.length > 0);
});

test('ASH Advantage-token batches resolve during combat without losing trigger ownership', { timeout: 30_000 }, async () => {
  const decks = readDecks();
  const result = await runGame({
    playerDeck: decks.find(deck => deck.id === 'ash-emperor-palpatine'),
    botDeck: decks.find(deck => deck.id === 'ash-luke-skywalker'),
    seed: 101, maxActions: 600,
  });
  assert.ok(result.promptCounts.batchTriggerResolution > 0, 'The regression must actually resolve a token batch.');
  assert.ok(result.winnerIds.length > 0);
});

test('easy and hard policies finish legal games through the same real rules engine', { timeout: 60_000 }, async (t) => {
  const decks = readDecks();
  for (const difficulty of ['easy', 'hard']) {
    await t.test(difficulty, async () => {
      const result = await runGame({ playerDeck: decks[0], botDeck: decks[1], seed: 910, difficulty });
      assert.ok(result.winnerIds.length > 0);
    });
  }
});

test('real damage-distribution prompts reject forged targets, negative amounts and excess totals atomically', { timeout: 30_000 }, async () => {
  const decks = readDecks();
  let checked = false;
  await runGame({
    playerDeck: decks.find(deck => deck.id === 'jtl-boba-fett'),
    botDeck: decks.find(deck => deck.id === 'jtl-han-solo'), seed: 101,
    beforeSubmit({ session, view, decision }) {
      if (checked || decision.action.type !== 'stateful') return;
      const spec = view.prompt.distribution;
      const target = view.prompt.selectableCardIds[0];
      assert.ok(target, 'The real distribution prompt must provide a target.');
      for (const valueDistribution of [
        [{ uuid: 'forged-target', amount: 1 }],
        [{ uuid: target, amount: -1 }],
        [{ uuid: target, amount: spec.amount + 1 }],
        [{ uuid: target, amount: 1 }, { uuid: target, amount: 1 }],
      ]) {
        const action = { ...decision.action, result: { type: spec.type, valueDistribution } };
        assert.throws(() => session.submit(action, view.viewerId), /distribution|target|amount|total|legal|ability|hp/i);
        assert.deepEqual(session.view(view.viewerId), view, 'A malformed distribution must not partially apply damage.');
      }
      checked = true;
    },
  });
  assert.equal(checked, true, 'The real game must reach and validate a distribution prompt.');
});

test('attached upgrades and tokens are nested under units without duplicated arena combatants', { timeout: 30_000 }, async () => {
  const decks = readDecks();
  const result = await runGame({
    playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
    botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), seed: 101,
  });
  assert.ok(result.maxAttachedCards > 0, 'This real-game regression must actually include attached upgrades or tokens.');
  assert.ok(result.winnerIds.length > 0);
});
