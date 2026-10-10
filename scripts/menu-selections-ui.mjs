// Exercise real Yoda menu toggles and U-Wing selection order through HTTP and UI.
// Checkpoints contain only legal native actions; no board state is injected.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { createRecord, applyAction, sealRecord } = require('../server/replay.cjs');
const { importCustomDeck } = require('../server/custom-decks.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks } = require('./smoke.cjs');
const output = process.env.SWU_MENU_REPORT || '/tmp/swu-menu-selections';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
page.setDefaultTimeout(25_000);
const report = { passed: false, asset: null, yoda: null, orderedSearch: null, viewports: [], pageErrors: [] };
page.on('pageerror', error => report.pageErrors.push(error.message));
let fixture, view;

async function yodaCheckpoint() {
  const decks = readDecks();
  fixture = await createRecord({ playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'), botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), difficulty: 'normal', seed: 'manual-human-play' });
  const memory = {};
  async function bot() {
    for (let step = 0; step < 120; step++) {
      const state = fixture.game.botView();
      if (!state.prompt.active || !state.legalActions.length || state.ended) return;
      await applyAction(fixture.record, fixture.game, chooseAction(state, { difficulty: 'normal', memory }).action, 'bot');
    }
    assert.fail('The fixture bot must finish its turn.');
  }
  await bot();
  for (const [type, key] of [['button', 'keep'], ['card', 'Obi-Wan Kenobi'], ['card', 'General Dodonna'], ['button', 'done'], ['card', '2-1B Surgical Droid'], ['button', 'claimInitiative'], ['card', 'Asteroid Sanctuary'], ['button', 'done'], ['card', 'Yoda']]) {
    const state = fixture.game.view('human');
    const action = state.legalActions.find(candidate => candidate.type === type && (type === 'card' ? candidate.label === key : candidate.arg === key));
    assert.ok(action, `The fixture requires a legal ${type}: ${key}.`);
    await applyAction(fixture.record, fixture.game, action, 'human');
    await bot();
  }
  assert.match(fixture.game.view('human').prompt.title, /Choose any number of players/);
  const result = { id: fixture.record.id, token: sealRecord(fixture.record) };
  fixture.game.close(); fixture = null;
  return result;
}

async function orderedCheckpoint() {
  const decks = readDecks(), luke = decks.find(deck => deck.id === 'sor-luke-skywalker');
  const imported = await importCustomDeck({ metadata: { name: 'Ordered search regression' }, leader: luke.leader, base: { id: 'SOR_023' }, deck: luke.deck.filter(card => !['SOR_244', 'SOR_198', 'SOR_195'].includes(card.id)).concat({ id: 'SOR_104', count: 3 }) });
  assert.deepEqual(imported.errors, []);
  fixture = await createRecord({ playerDeck: imported.deck.recipe, botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), difficulty: 'normal', seed: 1 });
  for (let step = 0; step < 500; step++) {
    const state = ['human', 'bot'].map(seat => fixture.game.view(seat)).find(candidate => candidate.prompt.active && candidate.legalActions.length);
    assert.ok(state);
    if (state.viewerId === 'human' && state.prompt.type === 'displayCards' && /combined cost 7/.test(state.prompt.title)) {
      const pair = [];
      for (const card of state.prompt.displayCards.filter(card => card.selectionState === 'selectable').sort((a, b) => a.cost - b.cost)) {
        if (pair.reduce((total, item) => total + item.cost, 0) + card.cost <= 7) pair.push(card);
        if (pair.length === 2) break;
      }
      assert.equal(pair.length, 2);
      const result = { id: fixture.record.id, token: sealRecord(fixture.record), pair };
      fixture.game.close(); fixture = null;
      return result;
    }
    let action;
    if (state.prompt.stage === 'initiative') action = state.legalActions.find(candidate => candidate.label === (state.viewerId === 'human' ? 'Yourself' : 'Opponent'));
    else if (state.prompt.stage === 'mulligan') action = state.legalActions.find(candidate => candidate.arg === 'keep');
    else if (state.prompt.stage === 'resource') {
      if (state.prompt.selectedCardIds.length < state.prompt.resourceSelection.max) action = state.legalActions.find(candidate => candidate.type === 'card' && !state.prompt.selectedCardIds.includes(candidate.cardId) && candidate.label !== 'U-Wing Reinforcement');
      action ||= state.legalActions.find(candidate => candidate.arg === 'done');
    } else if (state.prompt.stage === 'action') {
      if (state.viewerId === 'human') action = state.legalActions.find(candidate => candidate.intent === 'play' && candidate.label === 'U-Wing Reinforcement');
      action ||= state.legalActions.find(candidate => candidate.arg === 'claimInitiative') || state.legalActions.find(candidate => candidate.arg === 'pass');
    } else action = state.legalActions.find(candidate => candidate.arg === 'pass') || state.legalActions[0];
    assert.ok(action);
    await applyAction(fixture.record, fixture.game, action, state.viewerId);
  }
  assert.fail('The native fixture must reach U-Wing’s real ordered search.');
}

async function clearSession() {
  if (!view?.sessionToken) return;
  const response = await fetch(`${origin}/api/games/${view.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: view.sessionToken }) });
  assert.equal(response.status, 204, await response.text());
  view = null;
}

async function resume(saved) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  report.asset = await page.locator('script[type="module"][src]').getAttribute('src');
  await page.evaluate(({ id, token }) => { localStorage.setItem('swu-command-session', id); localStorage.setItem(`swu-command-state:${id}`, token); }, saved);
  await page.reload({ waitUntil: 'networkidle' });
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${saved.id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

async function act(click) {
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`) && response.request().method() === 'POST');
  pending.catch(() => {});
  await click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  assert.deepEqual(view.warnings, []);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

function menuButton(label) { return page.locator('.prompt-buttons').getByRole('button', { name: label, exact: true }); }
async function selected(label, value) {
  assert.equal(await menuButton(label).getAttribute('aria-pressed'), String(value));
  assert.equal(await menuButton(label).locator('.prompt-selected-check').count(), value ? 1 : 0);
  assert.equal(view.prompt.buttons.find(button => button.text === label)?.selected, value, 'The visible toggle must match the native prompt metadata.');
}
async function viewport(label) {
  const facts = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  assert.ok(facts.scrollWidth <= facts.width + 1 && facts.scrollHeight <= facts.height + 1, `${label} must fit the viewport: ${JSON.stringify(facts)}`);
  report.viewports.push({ label, ...facts });
}

const cardId = card => card.uuid || card.cardUuid;
function displayed(card) { return page.locator(`.display-card-prompt .game-card:has(button[data-card-id="${cardId(card)}"])`); }
async function selectCard(card) { await act(() => displayed(card).locator('button.game-card-click').click()); }
async function order(card, number) {
  const native = view.prompt.displayCards.find(candidate => cardId(candidate) === cardId(card));
  const badge = displayed(card).locator('[data-selection-order]');
  assert.equal(native.selectionOrder, number);
  assert.equal(await badge.count(), number == null ? 0 : 1);
  if (number != null) {
    assert.equal(await badge.getAttribute('data-selection-order'), String(number));
    assert.equal((await badge.innerText()).trim(), String(number), 'The selected card must show its actual one-based play order.');
  }
}

try {
  await resume(await yodaCheckpoint());
  await selected('You', false); await selected('Opponent', false);
  assert.equal(await menuButton('Done').getAttribute('aria-pressed'), null, 'Done is a confirmation button, not a selectable player.');
  await act(() => menuButton('You').click());
  await selected('You', true); await selected('Opponent', false);
  await act(() => menuButton('Opponent').click());
  await selected('You', true); await selected('Opponent', true);
  await act(() => menuButton('You').click());
  await selected('You', false); await selected('Opponent', true);
  await viewport('Yoda selected opponent 375×667');
  await page.screenshot({ path: `${output}/yoda-opponent-only.png` });
  const before = { humanDeck: view.players.human.deckCount, botDeck: view.players.bot.deckCount, humanHand: view.players.human.handCount, botHand: view.players.bot.handCount };
  await act(() => menuButton('Done').click());
  assert.equal(view.players.human.deckCount, before.humanDeck, 'The deselected human must not draw a card.');
  assert.equal(view.players.bot.deckCount, before.botDeck - 1, 'The selected opponent must draw exactly one card.');
  assert.equal(view.players.human.handCount, before.humanHand);
  assert.doesNotMatch(view.prompt.title, /Choose any number of players/);
  report.yoda = { sequence: ['You', 'Opponent', 'You', 'Done'], deselectedPlayerDidNotDraw: true, opponentDrewExactlyOne: true, selectedCheckAndAriaMatch: true };

  await clearSession();
  const ordered = await orderedCheckpoint();
  await resume(ordered);
  await page.locator('.display-card-prompt').waitFor();
  const [first, second] = ordered.pair;
  await selectCard(first); await order(first, 1);
  await selectCard(second); await order(first, 1); await order(second, 2);
  await selectCard(first); await order(first, null); await order(second, 1);
  await selectCard(first); await order(second, 1); await order(first, 2);
  await viewport('U-Wing ordered selection 375×667');
  await page.screenshot({ path: `${output}/uwing-selection-order-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await viewport('U-Wing ordered selection desktop');
  await page.screenshot({ path: `${output}/uwing-selection-order-desktop.png` });
  const priorSequence = Math.max(0, ...(view.publicPlayEvents || []).map(event => event.sequence));
  await act(() => page.locator('.prompt-modal-actions').getByRole('button', { name: 'Play cards in selection order', exact: true }).click());
  // The first chosen card is Leia. Resolve her genuine When Played choice
  // before expecting the next selected unit to enter from the deck.
  assert.equal(second.name, 'Leia Organa');
  await act(() => menuButton('Ready a friendly resource').click());
  const played = (view.publicPlayEvents || []).filter(event => event.sequence > priorSequence && event.playerId === 'human');
  assert.deepEqual(played.map(event => event.card.uuid), [cardId(second), cardId(first)], 'Native play resolution must follow the displayed reordered selection.');
  report.orderedSearch = { cards: [second.name, first.name], deselectionRenumbers: true, reselectionAppends: true, nativePlayOrderMatches: true };
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  fixture?.game.close();
  await clearSession().catch(() => {});
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
