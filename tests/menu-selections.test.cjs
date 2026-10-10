'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createRecord, applyAction, sealRecord, restoreRecord } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks } = require('../scripts/smoke.cjs');

const decks = readDecks();
const options = {
  playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
  botDeck: decks.find(deck => deck.id === 'sor-darth-vader'),
  difficulty: 'normal', seed: 'manual-human-play',
};

// These are real human plays. Only the opposing seat uses the bot. Yoda is
// defeated by Open Fire, opening the native any-number-of-players draw menu.
function advanceToYodaPrompt(game, submit) {
  const memory = {};
  function bot() {
    for (let count = 0; count < 120; count++) {
      const view = game.botView();
      if (!view.prompt.active || !view.legalActions.length || view.ended) return;
      submit(chooseAction(view, { difficulty: 'normal', memory }).action, 'bot');
    }
    throw new Error('Bot failed to return control.');
  }
  bot();
  for (const [type, key] of [
    ['button', 'keep'], ['card', 'Obi-Wan Kenobi'], ['card', 'General Dodonna'],
    ['button', 'done'], ['card', '2-1B Surgical Droid'], ['button', 'claimInitiative'],
    ['card', 'Asteroid Sanctuary'], ['button', 'done'], ['card', 'Yoda'],
  ]) {
    const view = game.view('human');
    const action = view.legalActions.find(candidate => candidate.type === type
      && (type === 'card' ? candidate.label === key : candidate.arg === key));
    if (!action) throw new Error(`Missing ${type} ${key} during ${view.prompt.title}.`);
    submit(action, 'human');
    bot();
  }
  if (!game.view().prompt.title.includes('Choose any number of players')) throw new Error('Expected Yoda draw selection.');
}

function choice(game, label) {
  const view = game.view();
  const action = view.legalActions.find(action => action.type === 'button' && action.label === label);
  assert.ok(action, `Expected ${label} during ${view.prompt.title}.`);
  return { ...action, version: view.version };
}

function assertSelected(game, expected) {
  const view = game.view();
  for (const [label, selected] of Object.entries(expected)) {
    assert.equal(view.prompt.buttons.find(button => button.text === label)?.selected, selected,
      `The native ${label} button reports its selection state.`);
    assert.ok(view.legalActions.some(action => action.label === label),
      `The ${label} choice remains legal to toggle or confirm.`);
  }
}

function views(game) { return ['human', 'bot'].map(seat => game.canonicalView(seat)); }
function counts(game) {
  return Object.fromEntries(['human', 'bot'].map(seat => {
    const player = game.view().players[seat];
    return [seat, { hand: player.handCount, deck: player.deckCount }];
  }));
}

let historicalFixture;
function originalNativeFixture() {
  if (historicalFixture) return historicalFixture;
  // Only this isolated child loads the actual historical one-argument splice.
  // Generate old checkpoints independently of the new compatibility code; the
  // current process and every production session retain the corrected helper.
  const source = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const target = require.resolve('./vendor/forceteki/build/server/game/core/gameSteps/prompts/HandlerMenuMultipleSelectionPrompt.js');
    const loadJs = Module._extensions['.js'];
    Module._extensions['.js'] = function(module, filename) {
      if (filename !== target) return loadJs(module, filename);
      const source = fs.readFileSync(filename, 'utf8');
      const corrected = 'selectedOptions.splice(selectedOptions.indexOf(choice), 1);';
      if (!source.includes(corrected)) throw new Error('Expected the corrected native helper.');
      module._compile(source.replace(corrected, 'selectedOptions.splice(selectedOptions.indexOf(choice));'), filename);
    };
    const { createRecord } = require('./server/replay.cjs');
    const { chooseAction } = require('./server/bot.cjs');
    const advanceToYodaPrompt = ${advanceToYodaPrompt.toString()};
    const views = ${views.toString()};
    const counts = ${counts.toString()};
    (async () => {
      const { record, game } = await createRecord(${JSON.stringify(options)});
      try {
        const submit = (action, playerId = 'human') => {
          game.submit(action, playerId);
          const saved = { type: action.type };
          for (const key of ['cardId', 'arg', 'result']) if (action[key] !== undefined) saved[key] = action[key];
          record.actions.push({ playerId, action: saved });
        };
        advanceToYodaPrompt(game, submit);
        const before = counts(game);
        let prefix;
        for (const [index, label] of ['You', 'Opponent', 'You', 'Done'].entries()) {
          const action = game.view().legalActions.find(action => action.type === 'button' && action.label === label);
          if (!action) throw new Error('Missing old choice ' + label);
          submit(action);
          if (index === 1) prefix = { record: structuredClone(record), views: views(game) };
        }
        process.stdout.write(JSON.stringify({ before, prefix, completed: { record, views: views(game), counts: counts(game) } }));
      } finally { game.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env },
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  historicalFixture = JSON.parse(child.stdout);
  return historicalFixture;
}

test('Yoda menu toggles expose on/off selection and only the remaining opponent draws', async () => {
  const { record, game } = await createRecord(options);
  try {
    advanceToYodaPrompt(game, (action, seat) => applyAction(record, game, action, seat));
    const before = counts(game);
    assertSelected(game, { You: false, Opponent: false, Done: false });
    applyAction(record, game, choice(game, 'You'));
    assertSelected(game, { You: true, Opponent: false, Done: false });
    applyAction(record, game, choice(game, 'Opponent'));
    assertSelected(game, { You: true, Opponent: true, Done: false });
    // A caller cannot choose historical behavior by adding a payload property.
    applyAction(record, game, { ...choice(game, 'You'), rulesRevision: 0 });
    assertSelected(game, { You: false, Opponent: true, Done: false });
    applyAction(record, game, choice(game, 'Done'));
    assert.deepEqual(counts(game), {
      human: before.human, bot: { hand: before.bot.hand + 1, deck: before.bot.deck - 1 },
    });
    assert.ok(record.actions.every(item => item.rulesRevision === 1));
    assert.ok(record.actions.every(item => item.action.rulesRevision === undefined));
    const restored = await restoreRecord(sealRecord(record), { decks });
    try { assert.deepEqual(views(restored.game), views(game)); }
    finally { restored.game.close(); }
  } finally { game.close(); }
});

test('untagged historical checkpoints preserve the original Yoda outcome without invalidating the session', async () => {
  const fixture = originalNativeFixture();
  assert.deepEqual(fixture.completed.counts, fixture.before, 'The old native suffix-removal bug drew for neither player.');
  assert.ok(fixture.completed.record.actions.every(item => item.rulesRevision === undefined));
  for (const explicitZero of [false, true]) {
    const record = structuredClone(fixture.completed.record);
    if (explicitZero) for (const item of record.actions) item.rulesRevision = 0;
    const restored = await restoreRecord(sealRecord(record), { decks });
    try {
      assert.equal(restored.record.format, 1);
      assert.deepEqual(views(restored.game), fixture.completed.views);
      assert.deepEqual(counts(restored.game), fixture.before);
    } finally { restored.game.close(); }
  }
});

test('a historical prefix and corrected new menu choices survive repeated encrypted replay', async () => {
  const fixture = originalNativeFixture();
  const { record, game } = await restoreRecord(sealRecord(fixture.prefix.record), { decks });
  try {
    assert.deepEqual(views(game), fixture.prefix.views);
    assertSelected(game, { You: true, Opponent: true });
    const before = views(game);
    const selected = choice(game, 'You');
    for (const invalid of [{ ...selected, promptId: 'stale' }, { ...selected, arg: '999' }, { ...selected, version: -1 }]) {
      assert.throws(() => game.submit(invalid, 'human', { rulesRevision: 0 }));
      assert.deepEqual(views(game), before, 'Rejected replay actions cannot pretrim the active selection.');
    }
    applyAction(record, game, selected);
    assertSelected(game, { You: false, Opponent: true });
    applyAction(record, game, choice(game, 'Done'));
    assert.deepEqual(counts(game), {
      human: fixture.before.human, bot: { hand: fixture.before.bot.hand + 1, deck: fixture.before.bot.deck - 1 },
    });
    assert.ok(record.actions.slice(0, -2).every(item => item.rulesRevision === undefined));
    assert.deepEqual(record.actions.slice(-2).map(item => item.rulesRevision), [1, 1]);
    const restored = await restoreRecord(sealRecord(record), { decks });
    try {
      assert.deepEqual(restored.record.actions, record.actions);
      assert.deepEqual(views(restored.game), views(game));
      const again = await restoreRecord(sealRecord(restored.record), { decks });
      try { assert.deepEqual(views(again.game), views(game)); }
      finally { again.game.close(); }
    } finally { restored.game.close(); }
  } finally { game.close(); }
});

test('saved actions reject malformed or unknown rules revisions before replay', () => {
  const record = originalNativeFixture().completed.record;
  for (const invalid of [-1, 2, 1.5, '0', '1', null, false, {}, []]) {
    const malformed = structuredClone(record);
    malformed.actions[0].rulesRevision = invalid;
    assert.throws(() => sealRecord(malformed), { code: 'INVALID_SESSION' });
  }
});
