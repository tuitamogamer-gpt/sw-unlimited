// Exercise both hand presentations against sealed native-engine checkpoints.
// Card plays and resource choices use the visible UI and real HTTP actions.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { createRecord, applyAction, sealRecord } = require('../server/replay.cjs');
const { readDecks, assertPrivateView } = require('./smoke.cjs');
const output = process.env.SWU_HAND_FAN_REPORT || '/tmp/swu-hand-fan';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const report = { passed: false, assets: [], viewports: [], resourceChoices: [], cardPlays: [], shortcuts: [], pageErrors: [] };
const decks = readDecks();
const luke = decks.find(deck => deck.id === 'sor-luke-skywalker');
const vader = decks.find(deck => deck.id === 'sor-darth-vader');
const gunship = 'Auzituck Liberator Gunship';
const ownedGames = new Map();
let page; let view; let mutations = 0;

async function checkpoint(kind) {
  const { record, game } = await createRecord({ playerDeck: luke, botDeck: vader, difficulty: 'normal', seed: 2 });
  try {
    for (let step = 0; step < 240; step++) {
      const views = ['human', 'bot'].map(seat => game.view(seat));
      views.forEach(assertPrivateView);
      const state = views.find(candidate => candidate.prompt.active && candidate.legalActions.length);
      assert.ok(state, 'Every preparation step must have a native legal decision.');
      let action;
      if (state.viewerId === 'human') {
        if (kind === 'resources' && state.prompt.stage === 'resource' && state.players.human.resourceCount === 0) {
          return { id: record.id, token: sealRecord(record), version: state.version };
        }
        if (kind === 'play' && state.prompt.stage === 'action'
          && state.players.bot.space.some(card => card.name === 'TIE/ln Fighter')) {
          const play = state.legalActions.find(action => action.intent === 'play' && action.label === gunship);
          if (play && state.players.human.handCount >= 8) return { id: record.id, token: sealRecord(record), version: state.version, sourceId: play.cardId };
        }
      }
      const button = arg => state.legalActions.find(action => action.type === 'button' && action.arg === arg);
      if (state.prompt.stage === 'initiative') action = state.legalActions.find(action => action.label === (state.viewerId === 'human' ? 'Yourself' : 'Opponent'));
      else if (state.prompt.stage === 'mulligan') action = button('keep');
      else if (state.prompt.stage === 'resource') {
        if (state.prompt.selectedCardIds.length < state.prompt.resourceSelection.max) {
          action = state.legalActions.find(action => action.type === 'card' && !state.prompt.selectedCardIds.includes(action.cardId)
            && action.label !== (state.viewerId === 'human' ? gunship : 'TIE/ln Fighter'));
        }
        action ||= button('done');
      } else if (state.prompt.stage === 'action') {
        if (state.viewerId === 'bot' && !state.players.bot.space.some(card => card.name === 'TIE/ln Fighter')) {
          action = state.legalActions.find(action => action.intent === 'play' && action.label === 'TIE/ln Fighter');
        }
        action ||= button('claimInitiative') || button('pass');
      } else action = button('pass') || state.legalActions[0];
      assert.ok(action, `Preparing ${kind} must use a native legal action.`);
      applyAction(record, game, action, state.viewerId);
    }
    assert.fail(`The real starter game must reach the ${kind} checkpoint.`);
  } finally { game.close(); }
}

function handPanel() { return page.locator('#hand-fan-panel'); }
function handToggle() { return page.locator('.hand-toggle'); }

async function waitHand(open) {
  await handPanel().waitFor({ state: open ? 'visible' : 'detached' });
  assert.equal(await handToggle().getAttribute('aria-expanded'), String(open));
  assert.equal(await handToggle().getAttribute('aria-controls'), open ? 'hand-fan-panel' : null);
  if (open) {
    assert.equal(await handPanel().getAttribute('role'), 'region');
    assert.equal(await handPanel().getAttribute('aria-label'), 'Your hand');
    assert.equal(await handPanel().locator('.hand-fan-slot').count(), view.players.human.handCount,
      'The fan shows exactly the current player’s actual hand.');
  }
}

async function noGameAction(operation) {
  const before = mutations;
  const version = view.version;
  await operation();
  assert.equal(mutations, before, 'Changing the hand presentation must not submit a game action.');
  assert.equal(view.version, version);
}

async function restore(saved) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.evaluate(({ id, token }) => {
    localStorage.setItem('swu-language', 'en');
    localStorage.setItem('swu-command-session', id);
    localStorage.setItem(`swu-command-state:${id}`, token);
  }, saved);
  await page.reload({ waitUntil: 'networkidle' });
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${saved.id}/state`));
  pending.catch(() => {});
  await page.locator('.resume-button').click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  ownedGames.set(view.id, view);
  assertPrivateView(view);
  assert.equal(view.version, saved.version);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  const asset = await page.locator('script[type="module"][src]').getAttribute('src');
  if (!report.assets.includes(asset)) report.assets.push(asset);
}

async function act(operation) {
  const version = view.version;
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`)
    && response.request().method() === 'POST');
  pending.catch(() => {});
  await operation();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  ownedGames.set(view.id, view);
  assertPrivateView(view);
  assert.ok(view.version > version, 'A resource choice or card play must advance the native engine.');
  assert.deepEqual(view.warnings, []);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

async function clickFanCard(cardId, touch) {
  const button = handPanel().locator(`.game-card-click[data-card-id="${cardId}"]`);
  await button.waitFor();
  // A rotated card may be partially overlapped by its neighbours. Find a real
  // exposed part of this button rather than forcing a click through another.
  const point = await button.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (const fy of [0.25, 0.5, 0.75, 0.1, 0.9]) for (let fx = 0.05; fx < 1; fx += 0.05) {
      const x = box.left + box.width * fx; const y = box.top + box.height * fy;
      if (x < 1 || x >= innerWidth - 1 || y < 1 || y >= innerHeight - 1) continue;
      const target = document.elementFromPoint(x, y);
      if (target && element.contains(target)) return { x, y };
    }
    return null;
  });
  assert.ok(point, 'Each actionable card in the fan must have an exposed, clickable part.');
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function layout(label) {
  const facts = await page.evaluate(() => {
    const hand = document.querySelector('.hand-section').getBoundingClientRect();
    const arena = document.querySelector('.arenas').getBoundingClientRect();
    const fan = document.querySelector('#hand-fan-panel')?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, handHeight: hand.height, arenaHeight: arena.height,
      fan: fan ? { left: fan.left, right: fan.right, top: fan.top, bottom: fan.bottom } : null };
  });
  assert.ok(facts.scrollWidth <= facts.width + 1 && facts.scrollHeight <= facts.height + 1,
    `${label}: the battlefield must fit the viewport: ${JSON.stringify(facts)}`);
  if (facts.fan) assert.ok(facts.fan.left >= -1 && facts.fan.right <= facts.width + 1
    && facts.fan.top >= -1 && facts.fan.bottom <= facts.height + 1, `${label}: the fan panel must fit.`);
  report.viewports.push({ label, ...facts });
  return facts;
}

async function toggleMode(mode) {
  await noGameAction(() => page.getByRole('button', { name: mode === 'fan' ? 'Switch to fan hand' : 'Switch to classic hand', exact: true }).click());
  await page.locator(`.game-shell[data-hand-view="${mode}"]`).waitFor();
  await page.waitForFunction(expected => {
    try { return JSON.parse(localStorage.getItem('swu-command-preferences') || '{}').handView === expected; }
    catch { return false; }
  }, mode);
}

async function resourceFlow(label, touch) {
  const saved = await checkpoint('resources');
  await restore(saved);
  assert.equal(view.prompt.stage, 'resource');
  assert.equal(await page.locator('.game-shell').getAttribute('data-hand-view'), 'classic', 'A fresh browser keeps the classic hand by default.');
  const classic = await layout(`${label}-classic-resources`);
  await toggleMode('fan');
  await waitHand(true);
  const fan = await layout(`${label}-fan-resources`);
  assert.ok(fan.handHeight <= classic.handHeight - 35, 'The fan presentation must reclaim the classic hand’s permanent vertical space.');
  assert.ok(fan.arenaHeight > classic.arenaHeight, 'Reclaimed hand space should enlarge the battlefield.');
  const first = view.legalActions.find(action => action.type === 'card');
  await act(() => clickFanCard(first.cardId, touch));
  assert.deepEqual(view.prompt.selectedCardIds, [first.cardId]);
  await waitHand(true);
  await noGameAction(() => page.keyboard.press('Escape'));
  await waitHand(false);

  // Select the second resource through the existing native choice menu while
  // the hand is closed. Selection updates must not reopen a dismissed fan.
  const second = view.legalActions.find(action => action.type === 'card' && action.cardId !== first.cardId);
  await page.locator('.prompt-more-button').click();
  const menu = page.getByRole('dialog');
  await act(() => menu.locator(`.target-action-list button[data-card-id="${second.cardId}"]`).click());
  // The native multi-select prompt deliberately keeps its identity and menu
  // while selecting resources, so close that menu explicitly when finished.
  await waitHand(false);
  await noGameAction(() => page.keyboard.press('h'));
  await waitHand(false);
  await noGameAction(() => page.keyboard.press('Escape'));
  await menu.waitFor({ state: 'detached' });
  await waitHand(false);
  assert.equal(view.prompt.selectedCardIds.length, 2);
  await noGameAction(() => handToggle().click());
  await waitHand(true);
  assert.equal(await handPanel().locator('.game-card.is-selected').count(), 2);
  await act(() => clickFanCard(first.cardId, touch));
  assert.equal(view.prompt.selectedCardIds.length, 1, 'The fan supports native resource deselection.');
  await act(() => clickFanCard(first.cardId, touch));
  assert.equal(view.prompt.selectedCardIds.length, 2);
  await noGameAction(() => page.keyboard.press('Escape'));
  await waitHand(false);
  await act(() => page.locator('.prompt-panel button[data-action-arg="done"]').click());
  assert.equal(view.players.human.resourceCount, 2);
  assert.equal(view.players.human.handCount, 4);
  assert.equal(view.phase, 'action');
  await waitHand(false);
  await toggleMode('classic');
  await page.locator('.hand-cards .game-card-click').first().waitFor();
  report.resourceChoices.push({ label, selected: 2, deselection: true, dismissedFanStaysClosed: true, nativeResources: 2, classicRestored: true });
}

async function shortcutAndPlayFlow(label, touch) {
  const saved = await checkpoint('play');
  await restore(saved);
  assert.equal(view.prompt.stage, 'action');
  assert.ok(view.players.human.handCount >= 8, 'The fixture must exercise a crowded real hand.');
  assert.equal(await page.locator('.game-shell').getAttribute('data-hand-view'), 'classic', 'The selected classic mode must survive a full reload.');
  const initialHandCount = view.players.human.handCount;
  const classic = await layout(`${label}-classic-action`);
  await toggleMode('fan');
  await waitHand(false);
  const collapsed = await layout(`${label}-collapsed-action`);
  assert.ok(collapsed.handHeight <= classic.handHeight - 35);
  assert.ok(collapsed.arenaHeight > classic.arenaHeight);
  await noGameAction(() => restore({ id: view.id, token: view.sessionToken, version: view.version }));
  assert.equal(await page.locator('.game-shell').getAttribute('data-hand-view'), 'fan', 'The selected fan mode must survive a full reload.');
  await waitHand(false);

  await noGameAction(() => page.keyboard.press('h'));
  await waitHand(true);
  await noGameAction(() => page.keyboard.press('Escape'));
  await waitHand(false);
  await page.locator('.game-tools .language-select').focus();
  await noGameAction(() => page.keyboard.press('h'));
  await waitHand(false);
  await page.locator('.round-label').click();
  await noGameAction(() => handToggle().click());
  await waitHand(true);

  const beforeInspect = mutations;
  await handPanel().getByRole('button', { name: `Inspect ${gunship}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.ci-root').waitFor();
  await page.keyboard.press('h');
  assert.equal(await handToggle().getAttribute('aria-expanded'), 'true', 'H must not toggle the background hand through an inspector.');
  await page.keyboard.press('Escape');
  await page.locator('.ci-root').waitFor({ state: 'detached' });
  await waitHand(true);
  assert.equal(mutations, beforeInspect, 'Opening and closing inspection cannot play the card.');
  await page.mouse.move(1, 1);
  await layout(`${label}-open-fan`);
  await page.screenshot({ path: `${output}/${label}-fan.png`, animations: 'disabled' });
  report.shortcuts.push({ label, hOpens: true, escapeCloses: true, selectIgnored: true, inspectorIgnored: true, modesPersistAfterReload: true });

  const play = view.legalActions.find(action => action.intent === 'play' && action.cardId === saved.sourceId);
  assert.ok(play);
  await act(() => clickFanCard(play.cardId, touch));
  await waitHand(false);
  assert.equal(view.prompt.ability?.label, 'Ambush');
  assert.equal(view.players.human.hand.some(card => card.uuid === play.cardId), false);
  await act(() => page.locator('.prompt-panel button[data-action-arg="trigger"]').click());
  await waitHand(false);
  assert.equal(view.prompt.attackerId, play.cardId);
  await page.locator('.arenas[data-active-arena="space"]').waitFor();
  const target = view.legalActions.find(action => action.type === 'card' && action.label === 'TIE/ln Fighter');
  assert.ok(target);
  await act(() => page.locator(`.enemy-arena .game-card-click[data-card-id="${target.cardId}"]:visible`).click());
  assert.ok(view.players.bot.discard.some(card => card.uuid === target.cardId), 'The fan play must resolve actual native Ambush combat.');
  assert.equal(view.players.bot.base.damage, 0);
  await layout(`${label}-after-targeting`);
  await page.screenshot({ path: `${output}/${label}-targeting-complete.png`, animations: 'disabled' });
  report.cardPlays.push({ label, handCount: initialHandCount, source: gunship, closedBeforeTargeting: true, realCombat: true, noBaseAttack: true });
}

async function landscapeBasics() {
  for (const viewport of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    await toggleMode('classic');
    await layout(`landscape-${viewport.width}-classic`);
    await page.screenshot({ path: `${output}/landscape-${viewport.width}-classic.png`, animations: 'disabled' });
    // This real pointer click also checks that the mode button is not covered
    // by the classic card lane in a short landscape viewport.
    await toggleMode('fan');
    await waitHand(false);
    await noGameAction(() => handToggle().click());
    await waitHand(true);
    await layout(`landscape-${viewport.width}-fan`);
    await page.screenshot({ path: `${output}/landscape-${viewport.width}-fan.png`, animations: 'disabled' });
    await noGameAction(() => page.keyboard.press('Escape'));
    await waitHand(false);
  }
}

try {
  for (const { label, viewport, touch } of [
    { label: 'desktop', viewport: { width: 1440, height: 1000 }, touch: false },
    { label: 'mobile', viewport: { width: 375, height: 812 }, touch: true },
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    page = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/games\/[^/]+\/(actions|bot)$/.test(new URL(request.url()).pathname)) mutations++;
    });
    await resourceFlow(label, touch);
    await shortcutAndPlayFlow(label, touch);
    if (!touch) await landscapeBasics();
    await context.close();
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await page?.screenshot({ path: `${output}/failure.png`, animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  for (const saved of ownedGames.values()) {
    const response = await fetch(`${origin}/api/games/${saved.id}`, { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: saved.sessionToken }) }).catch(() => null);
    if (response && response.status !== 204) console.error(`Synthetic hand-test cleanup failed: ${response.status}`);
  }
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
