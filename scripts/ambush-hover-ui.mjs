// Verify Ambush guidance and desktop card previews through the real HTTP engine.
// Signed checkpoints come exclusively from legal, deterministic game actions.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { createRecord, applyAction, sealRecord } = require('../server/replay.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks } = require('./smoke.cjs');
const output = process.env.SWU_AMBUSH_HOVER_REPORT || '/tmp/swu-ambush-hover';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const contexts = [];
const report = { passed: false, ambush: {}, hover: [], dismissals: [], touch: null, viewports: [], pageErrors: [] };
let fixture, page, view;
let mutations = 0;
const preview = '[data-card-hover]';
const sourceSelector = id => `.unit-card:has(button[data-card-id="${id}"])`;
const cardButton = id => `button[data-card-id="${id}"]:visible`;

async function checkpoints({ exhaustTarget = false } = {}) {
  const decks = readDecks();
  fixture = await createRecord({ playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'), botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), difficulty: 'normal', seed: 101 });
  const memories = { human: {}, bot: fixture.record.memory };
  let beforePlay, exhaustedTargetId;
  for (let step = 0; step < 180; step++) {
    const state = ['human', 'bot'].map(seat => fixture.game.view(seat)).find(candidate => candidate.prompt.active && candidate.legalActions.length);
    assert.ok(state, 'The native fixture must have a legal action.');
    if (state.viewerId === 'human' && state.prompt.type === 'optionalTrigger' && state.prompt.ability?.label === 'Ambush') {
      assert.ok(beforePlay, 'The fixture must include the legal hand play before Ambush.');
      const result = { beforePlay, optional: { id: fixture.record.id, token: sealRecord(fixture.record) }, sourceId: state.prompt.ability.sourceCard.uuid, exhaustedTargetId };
      fixture.game.close(); fixture = null;
      return result;
    }
    let action = chooseAction(state, { difficulty: 'normal', memory: memories[state.viewerId] }).action;
    // A second legal branch lets the enemy attack first, so its exhausted unit
    // must remain an obvious, clickable Ambush target on a small touchscreen.
    if (exhaustTarget && state.version === 48) {
      action = state.legalActions.find(candidate => candidate.intent === 'attack' && state.players.bot.ground.some(card => card.uuid === candidate.cardId && card.damage > 0));
      exhaustedTargetId = action?.cardId;
    } else if (exhaustTarget && state.version === 49) action = state.legalActions.find(candidate => candidate.cardId === state.players.human.base.uuid);
    else if (exhaustTarget && state.version === 50) action = state.legalActions.find(candidate => candidate.label === 'Snowspeeder' && candidate.intent === 'play');
    assert.ok(action, 'Every fixture branch must submit an available native action.');
    if (state.viewerId === 'human' && action.label === 'Snowspeeder' && state.players.human.hand.some(card => card.uuid === action.cardId)) {
      beforePlay = { id: fixture.record.id, token: sealRecord(fixture.record), action };
    }
    await applyAction(fixture.record, fixture.game, action, state.viewerId);
  }
  assert.fail('The native fixture must reach Snowspeeder’s optional Ambush.');
}

async function newPage({ width = 1440, height = 1000, touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  contexts.push(context);
  const next = await context.newPage();
  next.setDefaultTimeout(20_000);
  next.on('pageerror', error => report.pageErrors.push(error.message));
  next.on('request', request => {
    if (request.method() === 'POST' && /\/api\/games\/[^/]+\/(actions|bot)$/.test(new URL(request.url()).pathname)) mutations++;
  });
  return next;
}

async function clearSession() {
  if (!view?.sessionToken) return;
  const response = await fetch(`${origin}/api/games/${view.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: view.sessionToken }) });
  assert.equal(response.status, 204, await response.text());
  view = null;
}

async function resume(next, checkpoint) {
  page = next;
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.evaluate(({ id, token }) => { localStorage.setItem('swu-command-session', id); localStorage.setItem(`swu-command-state:${id}`, token); }, checkpoint);
  await page.reload({ waitUntil: 'networkidle' });
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${checkpoint.id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  await page.locator('.game-shell').waitFor();
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.game-card img')].filter(image => image.getClientRects().length).every(image => image.complete));
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
  return view;
}

async function hoverCard(locator, label, face) {
  await page.mouse.move(1, 1);
  await locator.scrollIntoViewIfNeeded();
  const expected = await locator.getAttribute('data-card-hover-id');
  assert.ok(expected, `${label}: the public card must have a hover binding.`);
  const before = mutations;
  const started = Date.now();
  await locator.hover();
  await page.locator(preview).waitFor();
  const popup = page.locator(preview);
  await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).opacity === '1', preview);
  await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} img`)].every(image => image.complete), preview);
  assert.equal(await popup.getAttribute('data-hover-card-id'), expected, `${label}: the preview must match its hovered card.`);
  if (face) assert.equal(await popup.getAttribute('data-hover-card-face'), face);
  const layout = await popup.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const image = element.querySelector('img');
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, pointerEvents: getComputedStyle(element).pointerEvents, imageFit: image ? getComputedStyle(image).objectFit : null, title: element.querySelector('.card-hover-caption strong')?.textContent };
  });
  assert.ok(layout.width >= 180 && layout.width <= 322, `${label}: keep the card preview compact and readable.`);
  assert.ok(layout.left >= 10 && layout.top >= 10 && layout.right <= layout.viewportWidth - 10 && layout.bottom <= layout.viewportHeight - 10, `${label}: preview outside viewport: ${JSON.stringify(layout)}`);
  assert.equal(layout.pointerEvents, 'none', `${label}: preview must never intercept a card click.`);
  if (layout.imageFit) assert.equal(layout.imageFit, 'contain', `${label}: full artwork must remain visible.`);
  assert.ok(layout.title, `${label}: keep a readable name beside the artwork.`);
  assert.equal(mutations, before, `${label}: hovering must not submit a game action.`);
  report.hover.push({ label, appearanceMs: Date.now() - started, ...layout });
  return popup;
}

async function layout(label) {
  const result = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    elements: ['.game-topbar', '.opponent-row', '.friendly-row', '.hand-section', '.command-dock'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect(); return { selector, top: box.top, bottom: box.bottom, height: box.height };
    }) }));
  assert.ok(result.scrollWidth <= result.width + 1 && result.scrollHeight <= result.height + 1, `${label}: mobile game must fit one screen: ${JSON.stringify(result)}`);
  for (const element of result.elements) assert.ok(element.height > 0 && element.top >= -1 && element.bottom <= result.height + 1, `${label}: clipped ${element.selector}`);
  report.viewports.push({ label, ...result });
}

async function verifyOptional(sourceId) {
  assert.equal(view.prompt.type, 'optionalTrigger');
  assert.equal(view.prompt.ability?.label, 'Ambush');
  const source = view.players.human.ground.find(card => card.uuid === sourceId);
  assert.equal(source?.exhausted, true, 'Ambush must preserve the engine’s exhausted entry while awaiting the player’s choice.');
  await page.getByRole('button', { name: 'Use Ambush', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Skip Ambush', exact: true }).waitFor();
  const card = page.locator(sourceSelector(sourceId));
  assert.match(await card.innerText(), /Ambush/i, 'The played unit must clearly advertise its pending Ambush.');
  const cue = page.locator('[data-ambush-stage="optional"]');
  await cue.waitFor();
  assert.match(await cue.innerText(), /attack.*exhausted|ready/i, 'The explanation must clarify why an exhausted unit can use Ambush.');
  assert.match(await cue.innerText(), /enemy/i, 'The explanation must identify the immediate attack’s eligible targets.');
  return source;
}

async function verifyTargets(sourceId) {
  assert.equal(view.prompt.ability?.label, 'Ambush');
  assert.equal(view.prompt.ability?.sourceCard.uuid, sourceId);
  await page.locator('[data-ambush-stage="target"]').waitFor();
  const targets = view.legalActions.filter(action => action.type === 'card');
  assert.ok(targets.length > 0, 'Ambush must offer a legal enemy unit.');
  for (const action of targets) {
    const card = view.players.bot.ground.find(unit => unit.uuid === action.cardId);
    assert.ok(card, 'Ambush must target enemy units in the same arena, never either base.');
    assert.match(await page.locator(sourceSelector(action.cardId)).innerText(), /Target/i, 'Each eligible unit must have an explicit target label.');
    if (card.exhausted) {
      await page.locator(`${sourceSelector(action.cardId)} .card-exhausted-token`).waitFor();
      await page.locator(`${sourceSelector(action.cardId)} .card-action-label`).waitFor();
      assert.match(await page.locator(`${sourceSelector(action.cardId)} .card-action-label`).innerText(), /Target/i, 'Exhaustion must not hide an otherwise legal target action.');
    }
  }
  assert.equal(await page.locator('.base-target-label').count(), 0);
  return targets;
}

try {
  const saved = await checkpoints();
  await resume(await newPage(), saved.beforePlay);
  const sourceHand = page.locator(`.hand-card[data-card-hover-id="${saved.sourceId}"]`);
  await hoverCard(sourceHand, 'playable hand card');
  await page.screenshot({ path: `${output}/desktop-hand-hover.png` });
  await page.keyboard.press('Escape');
  await page.locator(preview).waitFor({ state: 'detached' });
  report.dismissals.push('Escape');
  await hoverCard(page.locator('.friendly-row .base-panel'), 'friendly base', 'front');
  await page.mouse.move(1, 1);
  await page.locator(preview).waitFor({ state: 'detached' });
  report.dismissals.push('pointer leave');
  await hoverCard(page.locator('.friendly-row .leader-mini [data-card-hover-id]').first(), 'leader face', 'front');
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.locator(preview).waitFor({ state: 'detached' });
  report.dismissals.push('resize');
  await hoverCard(page.locator('.enemy-arena .unit-card[data-card-hover-id]').first(), 'enemy battlefield unit');
  await page.mouse.move(1, 1);
  for (const hidden of [...view.players.bot.hand, ...view.players.bot.resources]) {
    if (hidden.uuid) assert.equal(await page.locator(`[data-card-hover-id="${hidden.uuid}"]`).count(), 0, 'Hidden enemy cards must never be hover targets.');
  }
  await hoverCard(sourceHand, 'hovered card remains playable');
  const previousVersion = view.version;
  await act(() => page.locator(cardButton(saved.sourceId)).first().click());
  assert.equal(view.version, previousVersion + 1);
  assert.equal(await page.locator(preview).count(), 0, 'A real card click must dismiss the preview.');
  report.dismissals.push('card action');
  await verifyOptional(saved.sourceId);
  await page.screenshot({ path: `${output}/ambush-choice-desktop.png` });
  await act(() => page.getByRole('button', { name: 'Use Ambush', exact: true }).click());
  const targets = await verifyTargets(saved.sourceId);
  await page.screenshot({ path: `${output}/ambush-target-desktop.png` });
  const chosen = targets.find(action => view.players.bot.ground.find(card => card.uuid === action.cardId)?.damage > 0) || targets[0];
  const enemyBaseDamage = view.players.bot.base.damage;
  await act(() => page.locator(cardButton(chosen.cardId)).first().click());
  assert.ok(view.players.bot.discard.some(card => card.uuid === chosen.cardId), 'The selected enemy unit must actually be defeated by the Ambush attack.');
  const attacker = [...view.players.human.ground, ...view.players.human.discard].find(card => card.uuid === saved.sourceId);
  assert.ok(attacker, 'The attacker must remain represented in public zones after combat.');
  assert.ok(attacker.damage >= 3 || attacker.zone === 'discard', 'Ambush must resolve combat damage in both directions.');
  assert.equal(view.players.bot.base.damage, enemyBaseDamage, 'Ambush must not redirect combat into the enemy base.');
  report.ambush = { source: attacker.name, playedExhausted: true, explicitChoice: true, validTargets: targets.length, enemyDefeated: true, combatResolved: true };

  await clearSession();
  const mobileSaved = await checkpoints({ exhaustTarget: true });
  await resume(await newPage({ width: 375, height: 667, touch: true }), mobileSaved.optional);
  await verifyOptional(mobileSaved.sourceId);
  await layout('Ambush choice 375×667');
  await page.screenshot({ path: `${output}/ambush-choice-mobile.png` });
  await page.locator(sourceSelector(mobileSaved.sourceId)).hover();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(preview).count(), 0, 'Touch devices must not display desktop hover previews.');
  const beforeTap = mutations;
  await act(() => page.locator(cardButton(mobileSaved.sourceId)).first().tap());
  assert.equal(mutations, beforeTap + 1, 'Tapping the Ambush source must submit exactly one trigger action.');
  const mobileTargets = await verifyTargets(mobileSaved.sourceId);
  assert.ok(mobileSaved.exhaustedTargetId && mobileTargets.some(action => action.cardId === mobileSaved.exhaustedTargetId), 'A real exhausted enemy must still be a legal Ambush target.');
  await layout('Ambush targets 375×667');
  await page.screenshot({ path: `${output}/ambush-target-mobile.png` });
  await page.setViewportSize({ width: 844, height: 390 });
  await layout('Ambush targets 844×390');
  await page.screenshot({ path: `${output}/ambush-target-landscape.png` });
  report.touch = { hoverDisabled: true, sourceTapTriggersAmbush: true, exhaustedTargetLabelVisible: true };

  await clearSession();
  page = await newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await hoverCard(page.locator('.deck-tile [data-card-hover-id]').first(), 'starter deck cover', 'front');
  await page.locator('.deck-tile-footer button').first().click();
  await page.locator('.di-root').waitFor();
  await hoverCard(page.locator('.di-leader'), 'deck inspector leader', 'front');
  await hoverCard(page.locator('.di-base'), 'deck inspector base', 'front');
  await hoverCard(page.locator('.di-card-row').first(), 'deck list card');
  await page.screenshot({ path: `${output}/deck-list-hover.png` });
  await page.mouse.wheel(0, 300);
  await page.locator(preview).waitFor({ state: 'detached' });
  report.dismissals.push('scroll');
  await hoverCard(page.locator('.di-card-row').first(), 'deck list card after scroll');
  await page.locator('.di-card-row').first().click();
  await page.locator('.ci-root').waitFor();
  assert.equal(await page.locator(preview).count(), 0, 'Clicking a hovered deck entry must open its normal inspector and dismiss the preview.');
  while (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Card library', exact: true }).click();
  await page.locator('.catalog-card').first().waitFor();
  await hoverCard(page.locator('.catalog-card').first(), 'card library item');
  await page.screenshot({ path: `${output}/catalog-hover.png` });
  await page.locator('.catalog-card').first().click();
  await page.locator('.ci-root').waitFor();
  assert.equal(await page.locator(preview).count(), 0);
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  if (fixture) fixture.game.close();
  await clearSession().catch(() => {});
  for (const context of contexts) await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
