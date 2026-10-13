// Verify multi-trigger guidance and card Rules help through persisted real games.
// Browser checkpoints are sealed only after legal native actions; no board or
// public game view is fabricated, and every tested choice uses the live HTTP API.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { createRecord, applyAction, sealRecord } = require('../server/replay.cjs');
const { importCustomDeck } = require('../server/custom-decks.cjs');
const { readDecks, assertPrivateView } = require('./smoke.cjs');
const output = process.env.SWU_PLAY_GUIDANCE_REPORT || '/tmp/swu-play-guidance';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const report = { passed: false, asset: null, rulesHelp: null, orders: [], noEffect: null, pageErrors: [] };
page.on('pageerror', error => report.pageErrors.push(error.message));
let mutations = 0, view;
page.on('request', request => {
  if (request.method() === 'POST' && /\/api\/games\/[^/]+\/(actions|bot)$/.test(new URL(request.url()).pathname)) mutations++;
});

const decks = readDecks();
const luke = decks.find(deck => deck.id === 'sor-luke-skywalker');
const vader = decks.find(deck => deck.id === 'sor-darth-vader');
const shipName = "Smuggler's YT-2400";
const units = player => [...player.ground, ...player.space];
const imported = await importCustomDeck({ ...luke, base: { id: 'SOR_024' },
  deck: luke.deck.filter(card => !['SOR_244', 'SOR_198', 'SOR_195'].includes(card.id))
    .concat({ id: 'LAW_148', count: 3 }) }, { name: 'Play guidance regression', allowUrl: false });
assert.deepEqual(imported.errors, []);

async function checkpoint(target) {
  const fixture = await createRecord({ playerDeck: imported.deck.recipe, botDeck: vader, seed: 2, difficulty: 'normal' });
  try {
    for (let step = 0; step < 240; step++) {
      const views = ['human', 'bot'].map(seat => fixture.game.view(seat));
      views.forEach(assertPrivateView);
      const state = views.find(state => state.prompt.active);
      assert.ok(state, 'The real fixture must always have a legal decision.');
      let action;
      if (state.prompt.stage === 'initiative') action = state.legalActions.find(action => action.label === (state.viewerId === 'human' ? 'Yourself' : 'Opponent'));
      else if (state.prompt.stage === 'mulligan') action = state.legalActions.find(action => action.arg === 'keep');
      else if (state.prompt.stage === 'resource') {
        if (state.prompt.selectedCardIds.length < state.prompt.resourceSelection.max) {
          action = state.legalActions.find(action => action.type === 'card' && !state.prompt.selectedCardIds.includes(action.cardId)
            && action.label !== (state.viewerId === 'human' ? shipName : target));
        }
        action ||= state.legalActions.find(action => action.arg === 'done');
      } else if (state.prompt.stage === 'action') {
        if (state.viewerId === 'human' && state.players.human.readyResources >= 6
          && units(state.players.bot).some(card => card.name === target)) {
          action = state.legalActions.find(action => action.intent === 'play' && action.label === shipName);
          if (action) {
            const played = applyAction(fixture.record, fixture.game, action, 'human');
            assert.equal(played.prompt.type, 'triggerWindow');
            return { id: fixture.record.id, token: sealRecord(fixture.record), sourceId: action.cardId,
              resourcesBeforePlay: state.players.human.readyResources, actionCount: fixture.record.actions.length };
          }
        }
        if (state.viewerId === 'bot' && !units(state.players.bot).some(card => card.name === target)) {
          action = state.legalActions.find(action => action.intent === 'play' && action.label === target);
        }
        action ||= state.legalActions.find(action => action.arg === 'claimInitiative') || state.legalActions.find(action => action.arg === 'pass');
      } else action = state.legalActions.find(action => action.arg === 'pass') || state.legalActions[0];
      assert.ok(action, `Every fixture action must be legal during ${state.prompt.title}.`);
      applyAction(fixture.record, fixture.game, action, state.viewerId);
    }
    assert.fail('The real custom deck must reach its space Ambush / When Played menu.');
  } finally { fixture.game.close(); }
}

async function clearSession() {
  if (!view?.sessionToken) return;
  const response = await fetch(`${origin}/api/games/${view.id}`, { method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: view.sessionToken }) });
  assert.equal(response.status, 204, await response.text());
  view = null;
}

async function resume(saved) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  report.asset = await page.locator('script[type="module"][src]').getAttribute('src');
  await page.evaluate(({ id, token }) => {
    localStorage.setItem('swu-language', 'en');
    localStorage.setItem('swu-command-session', id);
    localStorage.setItem(`swu-command-state:${id}`, token);
  }, saved);
  await page.reload({ waitUntil: 'networkidle' });
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${saved.id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  assertPrivateView(view);
  assert.equal(view.version, saved.actionCount, 'The rendered board must restore the exact signed legal-action checkpoint.');
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

const promptButton = arg => page.locator(`.prompt-panel button[data-action-arg="${arg}"]`);
async function act(click) {
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`) && response.request().method() === 'POST');
  pending.catch(() => {});
  await click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  assert.deepEqual(view.warnings, []);
  assertPrivateView(view);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

async function verifyMenu(saved, ambushHasEffects) {
  assert.equal(view.prompt.type, 'triggerWindow');
  await page.getByRole('heading', { name: 'Choose an ability to resolve', exact: true }).waitFor();
  if (page.viewportSize().width <= 720) {
    await page.locator('.arenas[data-active-arena="space"]').waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Space', exact: true }).getAttribute('aria-selected'), 'true',
      'A space trigger menu must reveal its source arena before any manual tab selection.');
  }
  assert.match(await page.locator('.prompt-panel .context-banner').innerText(), /which ability resolves first.*Remaining abilities follow/);
  assert.equal(await page.locator('.ability-choice-button').count(), 2);
  const choices = { ambush: view.prompt.buttons.find(button => button.label === 'Ambush'),
    whenPlayed: view.prompt.buttons.find(button => /give this unit \+1\/\+1/.test(button.label)) };
  assert.ok(choices.ambush && choices.whenPlayed);
  assert.equal(Boolean(choices.ambush.hasLegalEffects), ambushHasEffects);
  for (const choice of Object.values(choices)) {
    assert.equal(choice.sourceCard.uuid, saved.sourceId);
    const rendered = promptButton(choice.arg);
    await rendered.waitFor();
    assert.equal(await rendered.isEnabled(), true, 'A no-effect ordering choice remains usable under the native rules.');
    assert.equal(await rendered.locator('strong').innerText(), choice.label);
    assert.equal(await rendered.locator('.ability-source-name').innerText(), shipName);
  }
  assert.equal(await promptButton(choices.ambush.arg).locator('.ability-no-effect').count(), ambushHasEffects ? 0 : 1);
  if (!ambushHasEffects) assert.equal(await promptButton(choices.ambush.arg).locator('.ability-no-effect').innerText(), 'No effect now');
  assert.doesNotMatch(await page.locator('.prompt-panel').innerText(), /\{(?:keyword|resource):[^}]+\}/i,
    'Ability choices must display readable names and costs rather than engine tokens.');
  return choices;
}

async function verifyRulesHelp(saved) {
  const before = mutations;
  const spaceTab = page.getByRole('tab', { name: 'Space', exact: true });
  if (await spaceTab.isVisible()) await spaceTab.click();
  await page.getByRole('button', { name: `Inspect ${shipName}`, exact: true }).click();
  await page.locator('.ci-root').waitFor();
  const help = page.locator('.ci-rules-help');
  assert.equal(await help.locator('summary').innerText(), 'Rules help');
  await help.locator('summary').click();
  assert.equal(await help.evaluate(element => element.open), true);
  assert.equal(await help.locator('dt').innerText(), 'Ambush');
  const copy = await help.locator('dd').innerText();
  assert.match(copy, /enemy unit in the same arena/);
  assert.match(copy, /base is not a legal target/);
  assert.match(copy, /Ambush does not ready it/);
  await page.screenshot({ path: `${output}/source-rules-help.png` });
  await page.keyboard.press('Escape');
  await page.locator('.ci-root').waitFor({ state: 'detached' });
  assert.equal(mutations, before, 'Opening Rules help must not select a trigger or submit a game action.');
  assert.equal(view.prompt.type, 'triggerWindow');
  report.rulesHelp = { source: shipName, sameArenaExplained: true, baseRestrictionExplained: true, inspectionDoesNotAct: true };
}

async function finishAbility(kind, saved) {
  assert.equal(view.prompt.type, 'optionalTrigger');
  assert.equal(view.prompt.ability.sourceCard.uuid, saved.sourceId);
  assert.equal(view.prompt.ability.label === 'Ambush', kind === 'ambush');
  await act(() => promptButton('trigger').click());
  if (kind === 'ambush') {
    assert.equal(view.prompt.attackerId, saved.sourceId);
    assert.equal(view.prompt.ability.label, 'Ambush');
    const target = view.legalActions.find(action => action.label === 'TIE/ln Fighter');
    assert.ok(target, 'The space Ambush must offer its real same-arena enemy unit.');
    await page.locator('.arenas[data-active-arena="space"]').waitFor();
    await act(() => page.locator(`.enemy-arena .game-card-click[data-card-id="${target.cardId}"]:visible`).click());
    assert.ok(view.players.bot.discard.some(card => card.uuid === target.cardId), 'The UI attack choice must resolve actual combat.');
  }
}

try {
  for (const [index, first] of ['ambush', 'whenPlayed'].entries()) {
    await clearSession();
    await page.setViewportSize(index ? { width: 375, height: 812 } : { width: 1440, height: 1000 });
    const saved = await checkpoint('TIE/ln Fighter');
    await resume(saved);
    const choices = await verifyMenu(saved, true);
    if (index) {
      await page.waitForFunction(() => document.querySelector('#tab-space')?.getAttribute('aria-selected') === 'true');
      assert.equal(await page.getByRole('tab', { name: 'Space', exact: true }).getAttribute('aria-selected'), 'true',
        'A mobile resolution-order menu must show its source arena before any tab is manually selected.');
      await page.locator(`.friendly-arena .game-card-click[data-card-id="${saved.sourceId}"]:visible`).waitFor();
    }
    if (!index) await verifyRulesHelp(saved);
    await page.screenshot({ path: `${output}/trigger-order-${first}.png` });
    await act(() => promptButton(choices[first].arg).click());
    for (const kind of first === 'ambush' ? ['ambush', 'whenPlayed'] : ['whenPlayed', 'ambush']) await finishAbility(kind, saved);
    const ship = view.players.human.space.find(card => card.uuid === saved.sourceId);
    assert.equal(ship.power, 5);
    assert.equal(ship.hp, 6);
    assert.equal(ship.exhausted, true);
    assert.equal(view.players.human.readyResources, saved.resourcesBeforePlay - 6);
    assert.equal(view.players.bot.base.damage, 0);
    report.orders.push({ first, viewport: page.viewportSize(), sourceLabels: true, readableCost: true,
      mobileSourceArenaSelected: index ? true : undefined, remainingAbilityResolved: true, realCombatResolved: true });
  }

  await clearSession();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const saved = await checkpoint('Cell Block Guard');
  await resume(saved);
  const choices = await verifyMenu(saved, false);
  await page.screenshot({ path: `${output}/ambush-no-space-target.png` });
  await act(() => promptButton(choices.ambush.arg).click());
  assert.ok(/give this unit \+1\/\+1/.test(view.prompt.ability?.label), 'Selecting the no-effect Ambush must continue to the remaining When Played ability.');
  await finishAbility('whenPlayed', saved);
  assert.equal(view.players.human.space.find(card => card.uuid === saved.sourceId).power, 5);
  assert.equal(view.players.bot.base.damage, 0);
  assert.ok(view.players.bot.ground.some(card => card.name === 'Cell Block Guard' && card.damage === 0));
  report.noEffect = { explicitLabel: true, choiceUsable: true, remainingAbilityResolved: true, noCrossArenaOrBaseAttack: true };
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
  await clearSession().catch(() => {});
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
