'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createGame } = require('../server/engine.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { createRecord, sealRecord } = require('../server/replay.cjs');
const { readDecks } = require('../scripts/smoke.cjs');

const decks = readDecks();
const options = {
  playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
  botDeck: decks.find(deck => deck.id === 'sor-darth-vader'),
  difficulty: 'normal', seed: 'manual-human-play',
};

function button(view, arg) {
  const action = view.legalActions.find(candidate => candidate.type === 'button' && candidate.arg === arg);
  assert.ok(action, `Expected button ${arg} during ${view.prompt.title}.`);
  return action;
}

function cardAction(view, name) {
  const action = view.legalActions.find(candidate => candidate.type === 'card' && candidate.label === name);
  assert.ok(action, `Expected selectable ${name} during ${view.prompt.title}.`);
  return action;
}

function battlefield(player) { return [...player.ground, ...player.space]; }

function resourceBounds(view, min, max, selected, canSkip) {
  assert.equal(view.prompt.type, 'resource');
  assert.equal(view.prompt.stage, 'resource');
  assert.deepEqual(view.prompt.resourceSelection, { min, max, selected, canSkip });
}

function trace(view, action) {
  return {
    action, version: view.version, round: view.round, phase: view.phase, stage: view.prompt.stage,
    resources: view.players.human.resourceCount, ready: view.players.human.readyResources,
    ground: view.players.human.ground.map(card => card.name),
  };
}

test('hand play costs include real aspect penalties without exposing opponent play options', async () => {
  // Replacing the Cunning base with a Vigilance base removes Luke's Cunning
  // aspect. The printed two-cost Asteroid Sanctuary must therefore cost four.
  const game = await createGame({ ...options, playerDeck: { ...options.playerDeck, base: { id: 'SOR_021' } } });
  try {
    const initial = [game.view('human'), game.view('bot')].find(view => view.prompt.active);
    assert.equal(initial.prompt.stage, 'initiative');
    const yourself = initial.legalActions.find(action => action.label === 'Yourself');
    game.submit(yourself, initial.viewerId);
    const view = game.view('human');
    const event = view.players.human.hand.find(card => card.name === 'Asteroid Sanctuary');
    assert.ok(event, 'The deterministic opening hand contains the off-aspect event.');
    assert.equal(event.cost, 2);
    assert.equal(event.playCost, 4);
    assert.equal(event.playOptions[0].cost, 4);
    assert.equal(event.playable, false, 'Players cannot play cards during the mulligan step.');
    for (const card of view.players.bot.hand) {
      assert.equal(card.hidden, true);
      assert.equal(card.playOptions, undefined);
      assert.equal(card.playCost, undefined);
    }
  } finally { game.close(); }
});

// Human actions below are deliberate button/card selections, never chooseAction().
// The only automated strategy is the opposing bot, matching production autoplay.
async function playTwoHumanTurns(client, t) {
  const steps = [];
  let view = client.view;
  assert.equal(view.viewerId, 'human');
  view = await client.act(button(view, 'keep'));
  resourceBounds(view, 2, 2, 0, false);
  assert.equal(view.players.human.handCount, 6);
  assert.equal(view.players.human.resourceCount, 0);
  assert.ok(!view.legalActions.some(action => action.arg === 'done'), 'Two initial resources are mandatory.');

  for (const [index, name] of ['Obi-Wan Kenobi', 'General Dodonna'].entries()) {
    const action = cardAction(view, name);
    assert.equal(action.intent, 'resource');
    view = await client.act(action);
    resourceBounds(view, 2, 2, index + 1, false);
    assert.equal(view.players.human.resourceCount, 0, 'Selecting a resource waits for confirmation.');
    assert.equal(view.players.human.handCount, 6);
  }
  assert.equal(view.legalActions.filter(action => action.type === 'card').length, 2,
    'After the resource limit, only already selected cards can be toggled.');
  view = await client.act(button(view, 'done'));
  steps.push(trace(view, 'Confirm two initial resources'));
  assert.equal(view.round, 1);
  assert.equal(view.prompt.stage, 'action');
  assert.equal(view.prompt.type, 'actionWindow');
  assert.equal(view.prompt.resourceSelection, null);
  assert.equal(view.players.human.resourceCount, 2);
  assert.equal(view.players.human.readyResources, 2);
  assert.equal(view.players.human.handCount, 4);
  const unaffordableYoda = view.players.human.hand.find(card => card.name === 'Yoda');
  assert.equal(unaffordableYoda.playable, false);
  assert.equal(unaffordableYoda.playCost, 3);
  assert.ok(unaffordableYoda.playBlockedReason, 'An unaffordable hand card explains why it cannot be played yet.');
  assert.ok(!view.legalActions.some(action => action.cardId === unaffordableYoda.uuid));

  const firstPlay = cardAction(view, '2-1B Surgical Droid');
  const firstCard = view.players.human.hand.find(card => card.uuid === firstPlay.cardId);
  assert.equal(firstPlay.intent, 'play');
  assert.ok(firstPlay.abilities.some(ability => ability.type === 'play' && ability.cost === 1));
  assert.equal(firstCard.playable, true);
  assert.equal(firstCard.playCost, 1);
  const firstVersion = view.version;
  view = await client.act(firstPlay);
  steps.push(trace(view, 'Play 2-1B Surgical Droid; bot responds'));
  assert.ok(view.version > firstVersion + 1, 'The opposing bot responds automatically to the human play.');
  assert.ok(battlefield(view.players.human).some(card => card.uuid === firstPlay.cardId),
    'Clicking an affordable hand unit in the action phase puts it in its arena.');
  assert.ok(!view.players.human.hand.some(card => card.uuid === firstPlay.cardId));
  assert.ok(!view.players.human.resources.some(card => card.uuid === firstPlay.cardId),
    'Playing a unit must never silently convert it into a resource.');
  assert.equal(view.players.human.resourceCount, 2);
  assert.equal(view.players.human.readyResources, 1, 'Playing the cost-one unit exhausts one resource.');
  assert.ok(view.log.some(entry => entry.text === 'Player plays 2-1B Surgical Droid'));
  assert.ok(view.log.some(entry => /AI uses Darth Vader/.test(entry.text)), 'The bot takes an actual gameplay action.');

  view = await client.act(button(view, 'claimInitiative'));
  steps.push(trace(view, 'Claim initiative; enter optional resourcing'));
  resourceBounds(view, 0, 1, 0, true);
  assert.equal(button(view, 'done').label, 'Skip Resourcing', 'The next resource step offers a legal skip.');
  assert.equal(view.players.human.resourceCount, 2);
  view = await client.act(cardAction(view, 'Asteroid Sanctuary'));
  resourceBounds(view, 0, 1, 1, true);
  view = await client.act(button(view, 'done'));
  steps.push(trace(view, 'Confirm one optional resource'));
  assert.equal(view.round, 2);
  assert.equal(view.prompt.stage, 'action');
  assert.equal(view.players.human.resourceCount, 3);
  assert.equal(view.players.human.readyResources, 3);

  const secondPlay = cardAction(view, 'Yoda');
  const secondCard = view.players.human.hand.find(card => card.uuid === secondPlay.cardId);
  assert.equal(secondPlay.intent, 'play');
  assert.ok(secondPlay.abilities.some(ability => ability.type === 'play' && ability.cost === 3));
  assert.equal(secondCard.playable, true);
  assert.equal(secondCard.playCost, 3);
  view = await client.act(secondPlay);
  steps.push(trace(view, 'Play Yoda in round two; bot plays Open Fire'));
  assert.ok(view.log.some(entry => entry.text === 'Player plays Yoda'));
  assert.ok(!view.players.human.hand.some(card => card.uuid === secondPlay.cardId));
  assert.ok(!view.players.human.resources.some(card => card.uuid === secondPlay.cardId));
  assert.equal(view.players.human.resourceCount, 3);
  assert.equal(view.players.human.readyResources, 0);
  // In this reproducible game the bot legally defeats Yoda with Open Fire.
  assert.ok(view.players.human.discard.some(card => card.uuid === secondPlay.cardId));
  assert.ok(view.log.some(entry => /AI plays Open Fire/.test(entry.text)));
  assert.ok(/Choose any number of players/.test(view.prompt.title));
  const chooseSelf = view.legalActions.find(action => action.type === 'button' && action.label === 'You');
  assert.ok(chooseSelf, 'The human controls Yoda\'s When Defeated draw choice.');
  view = await client.act(chooseSelf);
  const done = view.legalActions.find(action => action.type === 'button' && action.label === 'Done');
  assert.ok(done);
  view = await client.act(done);
  assert.equal(view.prompt.stage, 'action');
  assert.equal(view.round, 2);
  t.diagnostic(JSON.stringify(steps));
}

test('human manually resources, plays a unit, receives a bot response, and plays again next round', { timeout: 30_000 }, async t => {
  const game = await createGame(options);
  const memory = {};
  function playBot() {
    for (let count = 0; count < 120; count++) {
      const observation = game.botView();
      if (!observation.prompt.active || !observation.legalActions.length || observation.ended) return;
      assert.equal(observation.viewerId, 'bot', 'Only the opposing seat uses the strategy engine.');
      const decision = chooseAction(observation, { difficulty: 'normal', memory });
      assert.ok(decision.action);
      game.submit({ ...decision.action, version: observation.version }, 'bot');
    }
    assert.fail('Bot autoplay failed to return control within 120 decisions.');
  }
  try {
    playBot();
    const client = {
      view: game.view('human'),
      async act(action) {
        game.submit({ ...action, version: this.view.version }, 'human');
        playBot();
        this.view = game.view('human');
        return this.view;
      },
    };
    await playTwoHumanTurns(client, t);
  } finally { game.close(); }
});

test('real HTTP actions let the human play from hand across two rounds with server bot autoplay', { timeout: 60_000 }, async t => {
  const { app } = require('../server/index.cjs');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cleanup = new Map();
  async function request(path, body, expected = 200, method = 'POST') {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    if (data?.id && data.sessionToken) cleanup.set(data.id, data.sessionToken);
    return data;
  }
  try {
    const created = await request('/api/games', {
      deckId: options.playerDeck.id, opponentDeckId: options.botDeck.id, difficulty: 'normal',
    }, 201);
    assert.equal(created.viewerId, 'human');
    assert.ok(created.prompt.active, 'Creating a game initializes the catalog and runs the bot until a human choice.');
    assert.equal(created.seed, undefined, 'The production create endpoint does not expose a shuffle seed.');

    // Restore a genuine encrypted server checkpoint for a repeatable opening.
    // No API-only testing hook or client-supplied seed is needed. Every following
    // human choice and every opposing response goes through the production app.
    const { record, game } = await createRecord(options);
    let initialToken;
    try { initialToken = sealRecord(record); } finally { game.close(); }
    const route = `/api/games/${record.id}`;
    const restored = await request(`${route}/state`, { sessionToken: initialToken });
    const ready = await request(`${route}/bot`, { sessionToken: restored.sessionToken });
    const client = {
      view: ready,
      async act(action) {
        this.view = await request(`${route}/actions`, {
          ...action, version: this.view.version, sessionToken: this.view.sessionToken,
        });
        assert.deepEqual(this.view.warnings, [], 'No manual bot retry should be required.');
        return this.view;
      },
    };
    await playTwoHumanTurns(client, t);
    assert.ok(client.view.botHistory.length > 0, 'HTTP responses include completed AI decisions.');
    const recovered = await request(`${route}/state`, { sessionToken: client.view.sessionToken });
    assert.equal(recovered.version, client.view.version);
    assert.deepEqual(recovered.players, client.view.players);
    assert.deepEqual(recovered.prompt, client.view.prompt);
  } finally {
    try {
      for (const [id, sessionToken] of cleanup) {
        await request(`/api/games/${id}`, { sessionToken }, 204, 'DELETE');
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
