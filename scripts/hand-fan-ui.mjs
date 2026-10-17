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
const report = { passed: false, assets: [], viewports: [], handStatuses: [], handNavigation: [], resizeNavigation: [], keyboardBrowsing: [],
  resourceChoices: [], cardPlays: [], shortcuts: [], trainingCompletion: [], pageErrors: [] };
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
function handLane() { return handPanel().locator('.hand-fan-cards'); }

async function waitHand(open) {
  await handPanel().waitFor({ state: open ? 'visible' : 'detached' });
  assert.equal(await handToggle().getAttribute('aria-expanded'), String(open));
  assert.equal(await handToggle().getAttribute('aria-controls'), open ? 'hand-fan-panel' : null);
  if (open) {
    await handPanel().evaluate(async panel => {
      await Promise.all(panel.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
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

async function handStatus(label) {
  const human = view.players.human;
  const resources = handPanel().locator('.hand-resource-status');
  await resources.waitFor({ state: 'visible' });
  const resourceText = (await resources.locator('.hand-resource-value').innerText()).replace(/\s/g, '');
  assert.equal(resourceText, `${human.readyResources}/${human.resourceCount}`,
    'The hand header must show ready and total resources from the current native state.');
  const handIds = new Set(human.hand.map(card => card.uuid));
  const legalPlays = new Set(view.legalActions.filter(action => action.intent === 'play' && handIds.has(action.cardId))
    .map(action => action.cardId)).size;
  const facts = { label, stage: view.prompt.stage, readyResources: human.readyResources, totalResources: human.resourceCount, legalPlays };
  if (view.prompt.stage === 'resource') {
    const selection = view.prompt.resourceSelection;
    assert.ok(selection, 'The selection status must come from the native resource prompt.');
    assert.equal(selection.selected, view.prompt.selectedCardIds.length);
    const status = handPanel().locator('.hand-selection-status');
    await status.waitFor({ state: 'visible' });
    assert.equal((await status.innerText()).replace(/\s+/g, ' ').trim(), `${selection.selected}/${selection.max} selected`);
    assert.equal(await handPanel().locator('.hand-playable-status').count(), 0,
      'Resource choices must display selection progress rather than a playable-card claim.');
    Object.assign(facts, { selected: selection.selected, max: selection.max });
  } else {
    const status = handPanel().locator('.hand-playable-status');
    await status.waitFor({ state: 'visible' });
    const copy = (await status.innerText()).replace(/\s+/g, ' ').trim();
    assert.equal(copy, view.prompt.stage === 'action' ? `${legalPlays} playable` : 'Review your cards',
      'Hand availability must follow legal play actions for this prompt, regardless of printed costs.');
    assert.equal(await status.getAttribute('data-available'), String(legalPlays > 0));
    Object.assign(facts, { status: copy });
  }
  report.handStatuses.push(facts);
}

async function settleHandLane() {
  await handPanel().evaluate(async panel => {
    await Promise.all(panel.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  return handLane().evaluate(async lane => {
    let previous = lane.scrollLeft; let stable = 0;
    const start = performance.now();
    while (performance.now() - start < 3000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const current = lane.scrollLeft;
      stable = Math.abs(current - previous) < 0.25 ? stable + 1 : 0;
      previous = current;
      if (stable >= 4 && performance.now() - start >= 120) return {
        scrollLeft: lane.scrollLeft, scrollWidth: lane.scrollWidth, clientWidth: lane.clientWidth,
      };
    }
    throw new Error('The hand lane must finish scrolling before checking card reachability.');
  });
}

async function exposedHandCards() {
  return handLane().evaluate(lane => {
    const bounds = lane.getBoundingClientRect();
    return [...lane.querySelectorAll('.game-card-click')].filter(button => {
      const box = button.getBoundingClientRect();
      for (const fy of [0.5, 0.3, 0.7]) for (const fx of [0.5, 0.2, 0.8, 0.05, 0.95]) {
        const x = box.left + box.width * fx; const y = box.top + box.height * fy;
        if (x <= Math.max(0, bounds.left) || x >= Math.min(innerWidth, bounds.right)
          || y <= Math.max(0, bounds.top) || y >= Math.min(innerHeight, bounds.bottom)) continue;
        const target = document.elementFromPoint(x, y);
        if (target && button.contains(target)) return true;
      }
      return false;
    }).map(button => button.getAttribute('data-card-id'));
  });
}

async function handNavigation(label, touch) {
  await noGameAction(async () => {
    const initial = await settleHandLane();
    const overflowing = initial.scrollWidth > initial.clientWidth + 1;
    const navigation = handPanel().locator('.hand-fan-navigation');
    const facts = { label, touch, handCount: view.players.human.handCount, ...initial, overflowing,
      navigationVisible: await navigation.isVisible(), nextClicks: 0, previousClicks: 0 };
    report.handNavigation.push(facts);
    assert.equal(overflowing, touch, touch
      ? 'The crowded touch hand must use a scrollable lane with separate card targets.'
      : 'Eight desktop cards should fit through adaptive overlap.');
    const reached = new Set(await exposedHandCards());
    if (overflowing) {
      await navigation.waitFor({ state: 'visible' });
      const previous = navigation.getByRole('button', { name: 'Previous cards', exact: true });
      const next = navigation.getByRole('button', { name: 'Next cards', exact: true });
      assert.equal(await previous.isDisabled(), true, 'The first hand page must not offer backward scrolling.');
      for (let step = 0; step < view.players.human.handCount + 2 && await next.isEnabled(); step++) {
        const before = (await settleHandLane()).scrollLeft;
        await next.click();
        const after = await settleHandLane();
        assert.ok(after.scrollLeft > before + 1, 'Next cards must move the hand lane forward.');
        facts.nextClicks++;
        for (const id of await exposedHandCards()) reached.add(id);
      }
      assert.equal(await next.isDisabled(), true, 'Repeated Next cards must reach the end of the hand.');
      const lastId = view.players.human.hand.at(-1).uuid;
      assert.ok((await exposedHandCards()).includes(lastId), 'The last real card must have a reachable exposed target at the end.');
      facts.lastCardReachable = true;
      facts.endScrollLeft = (await settleHandLane()).scrollLeft;
      await page.screenshot({ path: `${output}/${label}-hand-last-card.png`, animations: 'disabled' });
      for (let step = 0; step < view.players.human.handCount + 2 && await previous.isEnabled(); step++) {
        const before = (await settleHandLane()).scrollLeft;
        await previous.click();
        const after = await settleHandLane();
        assert.ok(after.scrollLeft < before - 1, 'Previous cards must move the hand lane backward.');
        facts.previousClicks++;
      }
      assert.equal(await previous.isDisabled(), true, 'Repeated Previous cards must restore the start of the hand.');
      assert.ok((await exposedHandCards()).includes(view.players.human.hand[0].uuid));
      assert.ok((await settleHandLane()).scrollLeft <= 1);
      facts.firstCardRestored = true;
    } else assert.equal(await navigation.isVisible(), false, 'A hand that fits must not display overflow navigation.');
    facts.reachedCardCount = reached.size;
    assert.deepEqual([...reached].sort(), view.players.human.hand.map(card => card.uuid).sort(),
      'Every real card must be reachable, including cards beyond the initial touch viewport.');
  });
}

async function keyboardBrowse(label) {
  const cards = handLane().locator('.game-card-click');
  const ids = await cards.evaluateAll(buttons => buttons.map(button => button.getAttribute('data-card-id')));
  assert.ok(ids.length >= 2);
  await noGameAction(async () => {
    await cards.first().focus();
    for (const [key, index] of [['End', ids.length - 1], ['ArrowLeft', ids.length - 2], ['Home', 0], ['ArrowRight', 1], ['Home', 0]]) {
      await page.keyboard.press(key);
      await page.waitForFunction(cardId => document.activeElement?.matches('.hand-fan-cards .game-card-click')
        && document.activeElement.getAttribute('data-card-id') === cardId, ids[index]);
      await settleHandLane();
      assert.ok((await exposedHandCards()).includes(ids[index]), `${key} must bring the focused card into view.`);
    }
  });
  report.keyboardBrowsing.push({ label, cardCount: ids.length, end: true, left: true, home: true, right: true, neverPlayed: true });
}

async function resizeHandNavigation(label) {
  const original = page.viewportSize();
  await noGameAction(async () => {
    for (const [name, viewport, expectedOverflow] of [
      ['narrow', { width: 375, height: 812 }, true], ['restored', original, false],
    ]) {
      await page.setViewportSize(viewport);
      await waitHand(true);
      const metrics = await settleHandLane();
      const overflowing = metrics.scrollWidth > metrics.clientWidth + 1;
      const navigationVisible = await handPanel().locator('.hand-fan-navigation').isVisible();
      report.resizeNavigation.push({ label: `${label}-${name}`, ...viewport, ...metrics, overflowing, navigationVisible });
      assert.equal(overflowing, expectedOverflow, 'The resize fixture must change whether the hand fits.');
      assert.equal(navigationVisible, overflowing, 'Hand navigation must follow the new lane geometry after a resize.');
    }
  });
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
  if (view.training?.status === 'complete') await page.locator('.training-guidance.complete').waitFor();
  else await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
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
  if (view.training?.status === 'complete') await page.locator('.training-guidance.complete').waitFor();
  else await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

async function clickFanCard(cardId, touch) {
  const button = handPanel().locator(`.game-card-click[data-card-id="${cardId}"]`);
  await button.waitFor();
  // A rotated card may be partially overlapped by its neighbours. Find a real
  // exposed part of this button rather than forcing a click through another.
  const point = await button.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95]) {
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
  report.viewports.push({ label, ...facts });
  assert.ok(facts.scrollWidth <= facts.width + 1 && facts.scrollHeight <= facts.height + 1,
    `${label}: the battlefield must fit the viewport: ${JSON.stringify(facts)}`);
  if (facts.fan) assert.ok(facts.fan.left >= -1 && facts.fan.right <= facts.width + 1
    && facts.fan.top >= -1 && facts.fan.bottom <= facts.height + 1, `${label}: the fan panel must fit: ${JSON.stringify(facts)}`);
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
  await handStatus(`${label}-resources-none-selected`);
  await page.screenshot({ path: `${output}/${label}-resources-none-selected.png`, animations: 'disabled' });
  const first = view.legalActions.find(action => action.type === 'card');
  await act(() => clickFanCard(first.cardId, touch));
  assert.deepEqual(view.prompt.selectedCardIds, [first.cardId]);
  await waitHand(true);
  await handStatus(`${label}-resources-one-selected`);
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
  await handStatus(`${label}-resources-two-selected`);
  await page.screenshot({ path: `${output}/${label}-resources-two-selected.png`, animations: 'disabled' });
  await act(() => clickFanCard(first.cardId, touch));
  assert.equal(view.prompt.selectedCardIds.length, 1, 'The fan supports native resource deselection.');
  await handStatus(`${label}-resources-deselected`);
  await act(() => clickFanCard(first.cardId, touch));
  assert.equal(view.prompt.selectedCardIds.length, 2);
  await handStatus(`${label}-resources-reselected`);
  await noGameAction(() => page.keyboard.press('Escape'));
  await waitHand(false);
  await act(() => page.locator('.prompt-panel button[data-action-arg="done"]').click());
  assert.equal(view.players.human.resourceCount, 2);
  assert.equal(view.players.human.handCount, 4);
  assert.equal(view.phase, 'action');
  await waitHand(false);
  await noGameAction(() => handToggle().click());
  await waitHand(true);
  await handStatus(`${label}-resources-committed`);
  await noGameAction(() => page.keyboard.press('Escape'));
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
  const languageSelect = page.locator('.language-select:visible').first();
  await languageSelect.focus();
  assert.equal(await languageSelect.evaluate(element => document.activeElement === element), true,
    'The editable-control shortcut check must focus the actually visible language select.');
  await noGameAction(() => page.keyboard.press('h'));
  await waitHand(false);
  await page.locator('.round-label').click();
  await noGameAction(() => handToggle().click());
  await waitHand(true);
  await handStatus(`${label}-action-ready`);
  await handNavigation(label, touch);
  if (!touch) await resizeHandNavigation(label);
  await keyboardBrowse(label);

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
  // Printed costs do not make another play legal during a pending ability.
  // The header must follow the native prompt and the resources just paid.
  await noGameAction(() => handToggle().click());
  await waitHand(true);
  await handStatus(`${label}-ambush-pending`);
  assert.equal(view.legalActions.some(action => action.intent === 'play'), false);
  await noGameAction(() => page.keyboard.press('Escape'));
  await waitHand(false);
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
    const classic = await layout(`landscape-${viewport.width}-classic`);
    assert.ok(classic.arenaHeight >= 100, 'Short landscape classic mode must retain a usable battlefield.');
    await page.screenshot({ path: `${output}/landscape-${viewport.width}-classic.png`, animations: 'disabled' });
    // This real pointer click also checks that the mode button is not covered
    // by the classic card lane in a short landscape viewport.
    await toggleMode('fan');
    await waitHand(false);
    await noGameAction(() => handToggle().click());
    await waitHand(true);
    const fan = await layout(`landscape-${viewport.width}-fan`);
    assert.ok(fan.arenaHeight >= 100, 'Short landscape fan mode must retain a usable battlefield.');
    await page.screenshot({ path: `${output}/landscape-${viewport.width}-fan.png`, animations: 'disabled' });
    await noGameAction(() => page.keyboard.press('Escape'));
    await waitHand(false);
  }
}

async function trainingCompletionFlow(label, touch) {
  assert.equal(await page.locator('.game-shell').getAttribute('data-hand-view'), 'fan');
  const previousId = view.id;
  await page.locator('.game-topbar').getByRole('button', { name: 'Back to command', exact: true }).click();
  await page.locator('.training-selector').waitFor();
  const pending = page.waitForResponse(response => response.url().endsWith('/api/training/resources')
    && response.request().method() === 'POST');
  pending.catch(() => {});
  await page.getByRole('button', { name: 'Start lesson: Choose your resources', exact: true }).click();
  await page.getByRole('dialog', { name: 'Start a new game?', exact: true })
    .getByRole('button', { name: 'Start new game', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 201, await response.text());
  view = await response.json();
  ownedGames.delete(previousId); // The real start-lesson flow deletes its replaced synthetic match.
  ownedGames.set(view.id, view);
  assertPrivateView(view);
  assert.equal(view.training.lessonId, 'resources');
  assert.equal(view.training.status, 'active');
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('.game-shell').getAttribute('data-hand-view'), 'fan', 'Starting a lesson retains the chosen hand mode.');
  await waitHand(true);
  await handStatus(`${label}-training-resources-none-selected`);
  for (let index = 0; index < 2; index++) {
    const action = view.legalActions.find(action => action.type === 'card' && !view.prompt.selectedCardIds.includes(action.cardId));
    assert.ok(action);
    await act(() => clickFanCard(action.cardId, touch));
    await waitHand(true);
    await handStatus(`${label}-training-resources-${index + 1}-selected`);
  }
  await act(() => page.locator('.prompt-panel button[data-action-arg="done"]').click());
  assert.equal(view.training.status, 'complete');
  assert.equal(view.players.human.resourceCount, 2);
  await waitHand(false);
  await page.locator('.training-guidance.complete').waitFor();
  await layout(`${label}-training-complete`);
  await page.screenshot({ path: `${output}/${label}-training-complete.png`, animations: 'disabled' });
  report.trainingCompletion.push({ label, fanModeRetained: true, autoOpenedForResources: true, resources: 2,
    closedOnCompletion: true, nativePromptStage: view.prompt.stage });
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
    if (!touch) await page.setViewportSize(viewport);
    await trainingCompletionFlow(label, touch);
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
