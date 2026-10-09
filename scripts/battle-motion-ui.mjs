// Verify visible battle feedback using real, deterministic HTTP engine actions.
// Run after npm run build. No test state or engine endpoint is added to the app.
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
const output = process.env.SWU_MOTION_REPORT || '/tmp/swu-battle-motion';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const report = { passed: false, actions: 0, entry: null, exhaustion: null, damage: [], repeatedHit: null, repeatedUnitHit: null, shieldBreak: null, expiry: false, reducedMotion: {}, viewports: [], artwork: [], pageErrors: [] };
const contexts = [];
let fixture;
let activePage;
let view;
let entryCheckpoint;
let damageCheckpoint;

const board = state => Object.values(state.players).flatMap(player => [player.base, ...player.ground, ...player.space]);
const units = state => Object.values(state.players).flatMap(player => [...player.ground, ...player.space]);
const shield = card => card.name === 'Shield' || card.internalName === 'shield';
const fxSelector = (kind, cardId) => `.card-fx[data-fx-kind="${kind}"][data-fx-card-id="${cardId}"]`;

async function newPage(reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, reducedMotion });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__battleAnimations = [];
    window.__battleDamage = [];
    let previousDamage;
    const observeDamage = () => {
      const element = document.querySelector('[data-damage-presentation]');
      const key = element?.getAttribute('data-damage-event-ids');
      if (previousDamage?.key === key) return;
      if (previousDamage) previousDamage.endedAt = performance.now();
      previousDamage = null;
      if (!element) return;
      const item = { key, ids: key.split(','), startedAt: performance.now(), endedAt: null,
        summary: element.querySelector('.sr-only')?.textContent || element.textContent,
        amounts: [...element.querySelectorAll('[data-damage-amount]')].map(token => ({
          ids: token.getAttribute('data-damage-event-ids').split(','),
          targetId: token.getAttribute('data-damage-target-id'), amount: Number(token.getAttribute('data-damage-amount')),
          text: token.textContent.trim(),
        })) };
      window.__battleDamage.push(item);
      previousDamage = item;
    };
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(observeDamage).observe(document.body, { childList: true, subtree: true, attributes: true }));
    document.addEventListener('animationstart', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const fx = target.closest('[data-fx-id]');
      const card = target.closest('.game-card');
      const damage = target.closest('[data-damage-presentation]');
      window.__battleAnimations.push({ name: event.animationName, damageIds: damage?.getAttribute('data-damage-event-ids')?.split(',') || [], fxId: fx?.getAttribute('data-fx-id'), kind: fx?.getAttribute('data-fx-kind'),
        cardId: fx?.getAttribute('data-fx-card-id') || card?.querySelector('[data-card-id]')?.getAttribute('data-card-id'), time: performance.now() });
    });
  });
  return page;
}
async function resume(page, checkpoint) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.evaluate(({ id, token }) => { localStorage.setItem('swu-command-session', id); localStorage.setItem(`swu-command-state:${id}`, token); }, checkpoint);
  await page.reload({ waitUntil: 'networkidle' });
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${checkpoint.id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  await page.locator('.game-shell').waitFor();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.card-fx,[data-damage-presentation]').count(), 0, 'Resuming must not replay old movement or damage effects.');
  return view;
}
async function clearSession() {
  if (!view?.sessionToken) return;
  const response = await fetch(`${origin}/api/games/${view.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: view.sessionToken }) });
  assert.equal(response.status, 204, await response.text());
}
async function clickButton(page, arg) {
  const prompt = view.prompt;
  if (prompt.number && /^\d+$/.test(String(arg))) {
    await page.locator('#prompt-number').fill(String(arg));
    await page.locator('.number-prompt button').click();
    return;
  }
  if (prompt.dropdown?.includes(arg)) {
    await page.locator('.number-prompt select').selectOption(arg);
    await page.locator('.number-prompt button').click();
    return;
  }
  const buttons = prompt.buttons.filter(button => button.command !== 'statefulPromptResults'
    && !(prompt.number && /^\d+$/.test(button.arg)) && !prompt.dropdown?.includes(button.arg));
  const index = buttons.findIndex(button => String(button.arg) === String(arg));
  assert.ok(index >= 0, `No displayed button for ${arg}: ${prompt.title}`);
  if (await page.locator('.prompt-choice-body').count()) await page.getByRole('dialog').last().locator('.prompt-modal-actions > button').nth(index).click();
  else await page.locator('.prompt-buttons > button').nth(index).click();
  if (/claim.*initiative/i.test(`${arg}${buttons[index].text}`)) await page.getByRole('dialog', { name: 'Claim initiative?', exact: true }).getByRole('button', { name: 'Claim initiative', exact: true }).click();
}
async function clickAction(page, action) {
  if (action.type === 'button') return clickButton(page, action.arg);
  if (action.type === 'card') {
    let target = page.locator(`button[data-card-id="${action.cardId}"]:visible`).first();
    if (!await target.count()) {
      const space = [...view.players.human.space, ...view.players.bot.space].some(card => card.uuid === action.cardId);
      const tab = page.getByRole('tab', { name: space ? 'Space' : 'Ground', exact: true });
      if (await tab.isVisible()) await tab.click();
      target = page.locator(`button[data-card-id="${action.cardId}"]:visible`).first();
    }
    if (!await target.count()) { await page.locator('.prompt-more-button').click(); target = page.getByRole('dialog').last().locator(`button[data-card-id="${action.cardId}"]`).first(); }
    return target.click();
  }
  if (action.type === 'perCard') return page.locator(`button[data-action-arg="${action.arg}"][data-card-id="${action.cardId}"]`).click();
  if (action.type === 'stateful') {
    for (const entry of action.result.valueDistribution) await page.locator(`[data-target-id="${entry.uuid}"] input`).fill(String(entry.amount));
    return page.getByRole('button', { name: 'Confirm distribution', exact: true }).click();
  }
  assert.fail(`Unexpected action: ${action.type}`);
}
async function act(page, action, onDamage) {
  const before = view;
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`) && response.request().method() === 'POST');
  pending.catch(() => {});
  await clickAction(page, action);
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  const sequence = Math.max(0, ...(before.publicDamageEvents || []).map(event => event.sequence));
  const nativeHits = (view.publicDamageEvents || []).filter(event => event.sequence > sequence);
  // Observe damage while input is locked: it deliberately finishes before the
  // authoritative table returns. Snapshot deltas are no longer damage events.
  for (const event of nativeHits) {
    await page.waitForFunction(id => window.__battleDamage.some(frame => frame.ids.includes(id)), event.id);
    const frame = await page.evaluate(id => window.__battleDamage.find(candidate => candidate.ids.includes(id)), event.id);
    assert.ok(frame.summary.includes(event.targetCard.name), 'Each hit names the actual public target.');
    for (const source of event.sourceCards || (event.sourceCard ? [event.sourceCard] : [])) assert.ok(frame.summary.includes(source.name), 'Each hit names its native public source.');
    const amount = frame.amounts.find(token => token.ids.includes(event.id));
    assert.ok(amount, `Native damage ${event.id} must have a visible amount.`);
    const expectedAmount = nativeHits.filter(hit => amount.ids.includes(hit.id)).reduce((total, hit) => total + hit.amount, 0);
    assert.equal(amount.targetId, event.targetCard.uuid);
    assert.equal(amount.amount, expectedAmount, 'The displayed amount must match its native event(s), not the response-wide damage delta.');
    assert.ok(amount.text.includes(String(expectedAmount)), 'Damage must be readable on screen.');
    if (onDamage) await onDamage(event, page.locator(`[data-damage-presentation][data-damage-event-ids*="${event.id}"]`));
  }
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('[data-damage-presentation],.card-fx[data-fx-kind="damage"]').count(), 0, 'Resolved native hits expire without a duplicate aggregate damage effect.');
  assert.deepEqual(view.warnings, []);
  report.actions++;
  return nativeHits;
}
async function showArena(page, card) {
  if (!/Arena$/.test(card.zone || '')) return;
  const tab = page.getByRole('tab', { name: card.zone === 'spaceArena' ? 'Space' : 'Ground', exact: true });
  if (await tab.isVisible()) await tab.click();
  await page.locator(`.unit-card:has([data-card-id="${card.uuid}"])`).scrollIntoViewIfNeeded();
}
async function checkViewport(page, label) {
  const layout = await page.evaluate(() => {
    const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right }; };
    const selectors = ['.game-topbar', '.opponent-row', '.friendly-row', '.hand-section', '.command-dock'];
    const clipped = [...document.querySelectorAll('.arena-side .unit-card')].flatMap(card => {
      const box = rect(card), lane = rect(card.closest('.arena-side'));
      return box.height > 0 && (box.top < lane.top - 2 || box.bottom > lane.bottom + 2) ? [{ name: card.textContent, box, lane }] : [];
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      elements: selectors.map(selector => ({ selector, ...rect(document.querySelector(selector)) })), clipped };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1 && layout.scrollHeight <= layout.height + 1, `${label}: page overflow ${JSON.stringify(layout)}`);
  for (const element of layout.elements) assert.ok(element.height > 0 && element.top >= -1 && element.bottom <= layout.height + 1, `${label}: clipped ${element.selector}`);
  assert.deepEqual(layout.clipped, [], `${label}: unit card clipped in lane`);
  report.viewports.push({ label, width: layout.width, height: layout.height, fits: true });
}
async function waitForVisibleArtwork(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.unit-card')].filter(card => card.getClientRects().length).every(card => {
    const image = card.querySelector('img'); return image?.complete && image.naturalWidth > 0;
  }));
  return page.evaluate(() => [...document.querySelectorAll('.unit-card')].filter(card => card.getClientRects().length).map(card => {
    const image = card.querySelector('img'); return { cardId: card.querySelector('[data-card-id]')?.getAttribute('data-card-id'), width: image.naturalWidth, height: image.naturalHeight };
  }));
}
async function effect(page, kind, card, amount) {
  const selector = fxSelector(kind, card.uuid);
  await page.waitForFunction(({ selector, amount }) => [...document.querySelectorAll(selector)].some(element => amount == null || Number(element.getAttribute('data-fx-amount')) === amount), { selector, amount }, { timeout: 1500 });
  const locator = page.locator(selector).last();
  const id = await locator.getAttribute('data-fx-id');
  assert.ok(id);
  if (amount != null) {
    assert.equal(Number(await locator.getAttribute('data-fx-amount')), amount);
    assert.match(await locator.innerText(), new RegExp(String(amount)), `Damage ${amount} must be readable, not just stored in metadata.`);
  }
  return { locator, id };
}
async function captureFrame(page, locator, name, frameTime = 110) {
  await locator.evaluate((element, frameTime) => {
    const root = element.closest('.game-card,.base-panel,.leader-mini') || element;
    for (const animation of root.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = frameTime; }
  }, frameTime);
  await page.screenshot({ path: `${output}/${name}.png` });
  await locator.evaluate(element => {
    const root = element.closest('.game-card,.base-panel,.leader-mini') || element;
    for (const animation of root.getAnimations({ subtree: true })) animation.play();
  });
}
async function verifyExhaustion(page, card) {
  await showArena(page, card);
  const locator = page.locator(`.unit-card:has([data-card-id="${card.uuid}"])`);
  await locator.locator('.card-exhausted-token').waitFor();
  const presentation = await locator.evaluate(element => {
    const token = element.querySelector('.card-exhausted-token'), button = element.querySelector('.game-card-click'), image = button.querySelector('img');
    const tokenBox = token.getBoundingClientRect(), artBox = element.querySelector('.card-face').getBoundingClientRect();
    return { token: token.textContent.trim(), tokenTop: tokenBox.top, tokenHeight: tokenBox.height, artBottom: artBox.bottom,
      tokenColor: getComputedStyle(token).color, tokenBackground: getComputedStyle(token).backgroundColor, tokenGradient: getComputedStyle(token).backgroundImage,
      artFilter: image ? getComputedStyle(image).filter : '', cardFilter: getComputedStyle(element).filter,
      buttonFilter: getComputedStyle(button).filter, statsFilter: getComputedStyle(element.querySelector('.unit-stats')).filter };
  });
  assert.match(presentation.token, /Exhausted/i);
  assert.ok(presentation.tokenTop >= presentation.artBottom - 1, `The exhausted token must be outside the artwork: ${JSON.stringify(presentation)}`);
  assert.ok(presentation.tokenHeight <= 18, 'The exhausted indicator must stay compact.');
  assert.match(presentation.artFilter, /grayscale\((?!0\))/);
  assert.equal(presentation.cardFilter, 'none');
  assert.equal(presentation.buttonFilter, 'none');
  assert.equal(presentation.statsFilter, 'none', 'Resource and combat numbers must not inherit desaturation.');
  const colors = [...`${presentation.tokenBackground} ${presentation.tokenGradient}`.matchAll(/rgba?\(([^)]+)\)/g)].map(match => match[1].match(/\d+(?:\.\d+)?/g).map(Number));
  assert.ok(colors.some(rgb => rgb[0] > rgb[1] && rgb[0] > rgb[2] && (rgb.length < 4 || rgb[3] > 0)), `The exhausted token should be red: ${presentation.tokenBackground} ${presentation.tokenGradient}`);
  return presentation;
}

try {
  const decks = readDecks();
  fixture = await createRecord({ playerDeck: decks.find(deck => deck.id === 'jtl-boba-fett'), botDeck: decks.find(deck => deck.id === 'jtl-han-solo'), difficulty: 'normal', seed: 101 });
  for (let step = 0; step < 120 && fixture.game.botView().legalActions.length; step++) {
    const decision = chooseAction(fixture.game.botView(), { difficulty: 'normal', memory: fixture.record.memory });
    await applyAction(fixture.record, fixture.game, decision.action, 'bot');
  }
  activePage = await newPage();
  await resume(activePage, { id: fixture.record.id, token: sealRecord(fixture.record) });
  await checkViewport(activePage, 'portrait opening');
  const memory = {}, hits = new Map();
  for (let step = 0; step < 90 && !view.winnerIds.length; step++) {
    const before = view;
    const old = new Map(board(before).map(card => [card.uuid, card]));
    const decision = chooseAction(before, { difficulty: 'normal', memory });
    assert.ok(decision?.action, `No legal choice at ${before.prompt.title}`);
    const nativeHits = await act(activePage, decision.action, async (event, locator) => {
      if (!damageCheckpoint && event.targetCard.zone !== 'base') {
        damageCheckpoint = { id: before.id, token: before.sessionToken, action: decision.action, cardId: event.targetCard.uuid, amount: event.amount, eventId: event.id };
        await captureFrame(activePage, locator, 'damage-portrait-frame', 500);
      }
    });
    const entered = units(view).filter(card => !old.has(card.uuid));
    if (!report.entry && entered.length) {
      const card = entered.find(candidate => candidate.zone === 'groundArena') || entered[0];
      entryCheckpoint = { id: before.id, token: before.sessionToken, action: decision.action, cardId: card.uuid };
      const entry = await effect(activePage, 'enter', card);
      await showArena(activePage, card);
      await activePage.waitForFunction(({ id, cardId }) => window.__battleAnimations.some(event => event.fxId === id || event.cardId === cardId), { id: entry.id, cardId: card.uuid }, { timeout: 1000 });
      const animations = await activePage.evaluate(cardId => window.__battleAnimations.filter(event => event.cardId === cardId), card.uuid);
      const rim = animations.find(animation => animation.fxId === entry.id && animation.name === 'swu-entry-rim');
      assert.ok(rim, 'Entry must mount its keyed visual pulse.');
      assert.ok(animations.some(animation => animation.name === 'swu-card-enter' && animation.time >= rim.time - 100), 'A newly played unit must perform its card-entry motion.');
      report.entry = { name: card.name, id: entry.id, animations };
      if (card.exhausted) report.exhaustion = await verifyExhaustion(activePage, card);
      await captureFrame(activePage, entry.locator, 'entry-portrait-frame');
      await activePage.waitForFunction(() => !document.querySelector('.card-fx'), null, { timeout: 3500 });
      report.artwork.push({ label: 'stable exhausted portrait', cards: await waitForVisibleArtwork(activePage) });
      await activePage.screenshot({ path: `${output}/exhausted-portrait-stable.png` });
    }
    for (const hit of nativeHits) {
      const card = hit.targetCard;
      const previous = hits.get(card.uuid);
      if (previous && !report.repeatedHit) {
        assert.notEqual(hit.id, previous.id, 'A second hit must mount a fresh keyed exchange.');
        report.repeatedHit = { name: card.name, firstId: previous.id, nextId: hit.id, firstAmount: previous.amount, nextAmount: hit.amount };
      }
      if (previous && card.zone !== 'base' && !report.repeatedUnitHit) {
        const animations = await activePage.evaluate(id => window.__battleAnimations.filter(event => event.damageIds.includes(id)), hit.id);
        assert.ok(animations.some(event => event.name === 'swu-damage-number'), 'A later hit must restart its native damage number animation.');
        assert.notEqual(hit.id, previous.id);
        report.repeatedUnitHit = { name: card.name, firstId: previous.id, nextId: hit.id, amount: hit.amount, animation: 'swu-damage-number' };
      }
      hits.set(card.uuid, { id: hit.id, amount: hit.amount });
      report.damage.push({ name: card.name, source: hit.sourceCard?.name, amount: hit.amount, zone: card.zone, id: hit.id });
      const frame = await activePage.evaluate(id => window.__battleDamage.find(candidate => candidate.ids.includes(id)), hit.id);
      assert.ok(frame.endedAt > frame.startedAt, 'Damage presentation must expire and unlock the next action.');
      report.expiry = true;
    }
    for (const card of board(view)) {
      const prior = old.get(card.uuid);
      if (!prior) continue;
      const lostShield = (prior.upgrades || []).find(upgrade => shield(upgrade) && !(card.upgrades || []).some(next => next.uuid === upgrade.uuid));
      if (lostShield && !report.shieldBreak) {
        const broken = await effect(activePage, 'shieldBreak', card);
        await showArena(activePage, card);
        report.shieldBreak = { name: card.name, id: broken.id, shieldId: lostShield.uuid };
        await captureFrame(activePage, broken.locator, 'shield-break-portrait-frame');
      }
    }
    if (!report.exhaustion) {
      const exhausted = units(view).find(card => card.exhausted);
      if (exhausted) report.exhaustion = await verifyExhaustion(activePage, exhausted);
    }
    if (report.entry && report.exhaustion && damageCheckpoint && report.repeatedHit && report.repeatedUnitHit && report.shieldBreak) break;
  }
  assert.ok(report.entry && report.exhaustion && report.damage.length && report.repeatedHit && report.repeatedUnitHit && report.shieldBreak && report.expiry, `The deterministic fixture must exercise each effect: ${JSON.stringify(report)}`);
  for (const size of [{ width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await activePage.setViewportSize(size);
    for (const name of ['Ground', 'Space']) {
      const tab = activePage.getByRole('tab', { name, exact: true });
      if (await tab.isVisible()) await tab.click();
      await checkViewport(activePage, `${name.toLowerCase()} battle`);
      await activePage.waitForFunction(() => !document.querySelector('.card-fx,.arena-defeat-token'), null, { timeout: 3500 });
      report.artwork.push({ label: `${size.width}x${size.height} ${name}`, cards: await waitForVisibleArtwork(activePage) });
      await activePage.screenshot({ path: `${output}/battle-${size.width}x${size.height}-${name.toLowerCase()}-stable.png` });
    }
  }

  // Replay two genuine signed checkpoints in a fresh reduced-motion context.
  // Delete only this disposable local fixture from the worker cache before
  // replaying an earlier checkpoint; the UI itself is unchanged.
  for (const [kind, checkpoint] of [['enter', entryCheckpoint], ['damage', damageCheckpoint]]) {
    await clearSession();
    const page = await newPage('reduce');
    activePage = page;
    await resume(page, checkpoint);
    const before = view;
    const action = { ...checkpoint.action, promptId: view.prompt.id, version: view.version };
    let animationState;
    const inspectReducedMotion = async locator => locator.evaluate(element => {
      const root = element.closest('.game-card,.base-panel,.leader-mini') || element;
      return { media: matchMedia('(prefers-reduced-motion: reduce)').matches,
        moving: root.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1 && animation.effect?.getKeyframes().some(frame => ['transform', 'translate', 'rotate', 'scale', 'left', 'top'].some(key => frame[key] != null && !['none', '0px', '0deg', '1'].includes(String(frame[key]))))).map(animation => animation.animationName || 'transition'),
        readable: element.textContent.trim(), display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility };
    });
    await act(page, action, kind === 'damage' ? async (event, locator) => {
      if (event.id !== checkpoint.eventId) return;
      assert.equal(event.amount, checkpoint.amount);
      animationState = await inspectReducedMotion(locator);
      await checkViewport(page, 'reduced motion damage');
      await page.screenshot({ path: `${output}/reduced-damage.png` });
    } : undefined);
    if (kind === 'enter') {
      const card = board(view).find(card => card.uuid === checkpoint.cardId);
      assert.ok(card, 'The repeated real engine action must reach the same visible card.');
      const feedback = await effect(page, kind, card);
      await showArena(page, card);
      animationState = await inspectReducedMotion(feedback.locator);
      await checkViewport(page, 'reduced motion enter');
      await page.screenshot({ path: `${output}/reduced-enter.png` });
    }
    assert.ok(animationState, `The actual ${kind} presentation must be observed.`);
    assert.ok(animationState.media);
    assert.deepEqual(animationState.moving, [], `Reduced motion must disable moving effects: ${JSON.stringify(animationState)}`);
    assert.notEqual(animationState.display, 'none');
    assert.notEqual(animationState.visibility, 'hidden');
    if (kind === 'damage') assert.match(animationState.readable, new RegExp(String(checkpoint.amount)));
    assert.ok(view.version > before.version);
    report.reducedMotion[kind] = animationState;
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await activePage?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  fixture?.game.close();
  for (const context of contexts) await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
