// Exercise the opponent reveal with genuine engine plays and signed HTTP checkpoints.
// No mock game endpoint, client game state, or shortened product timer is used.
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
const output = process.env.SWU_PREVIEW_REPORT || '/tmp/swu-opponent-preview';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const contexts = [];
const report = { passed: false, single: null, queue: null, fallback: null, reducedMotion: null, resume: null, humanOnly: null, viewports: [], pageErrors: [] };
let page, view, fixture;
const units = state => Object.values(state.players).flatMap(player => [...player.ground, ...player.space]);
const cardSelector = id => `.unit-card:has([data-card-id="${id}"])`;
const previewSelector = '[data-opponent-preview]';

async function advanceBot(game, record) {
  for (let n = 0; n < 120; n++) {
    const state = game.botView();
    if (!state.prompt.active || !state.legalActions.length || state.winnerIds.length) return;
    await applyAction(record, game, chooseAction(state, { difficulty: 'normal', memory: record.memory }).action, 'bot');
  }
  assert.fail('Fixture bot turn did not finish.');
}
async function checkpoints() {
  const decks = readDecks();
  fixture = await createRecord({ playerDeck: decks.find(deck => deck.id === 'jtl-boba-fett'), botDeck: decks.find(deck => deck.id === 'jtl-han-solo'), difficulty: 'normal', seed: 101 });
  await advanceBot(fixture.game, fixture.record);
  const memory = {}, result = {};
  for (let step = 1; step <= 16; step++) {
    const before = fixture.game.view('human');
    const action = chooseAction(before, { difficulty: 'normal', memory }).action;
    const checkpoint = { id: fixture.record.id, token: sealRecord(fixture.record), action };
    if (step === 6) result.single = checkpoint;
    if (step === 16) {
      result.human = checkpoint;
      const claim = before.legalActions.find(candidate => candidate.arg === 'claimInitiative');
      assert.ok(claim, 'The native fixture must let the human end their round before multiple bot plays.');
      result.queue = { ...checkpoint, action: claim };
    }
    await applyAction(fixture.record, fixture.game, action, 'human');
    await advanceBot(fixture.game, fixture.record);
  }
  fixture.game.close();
  fixture = null;
  return result;
}
async function newPage({ reducedMotion = 'no-preference', width = 375, height = 667 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  contexts.push(context);
  const next = await context.newPage();
  next.setDefaultTimeout(20_000);
  next.on('pageerror', error => report.pageErrors.push(error.message));
  await next.addInitScript(() => {
    window.__previewTimeline = [];
    window.__previewAnimations = [];
    let last = '';
    const observe = () => {
      const preview = document.querySelector('[data-opponent-preview]');
      const cardId = preview?.getAttribute('data-preview-card-id');
      const ready = preview?.getAttribute('data-preview-ready') === 'true';
      const sequence = preview?.getAttribute('data-preview-sequence');
      const key = `${sequence || ''}:${cardId || ''}:${ready}`;
      if (key !== last) {
        window.__previewTimeline.push({ cardId, sequence, ready, time: performance.now() });
        last = key;
      }
    };
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(observe).observe(document.body, { subtree: true, attributes: true, childList: true }));
    document.addEventListener('animationstart', event => {
      const card = event.target.closest?.('.unit-card');
      if (card) window.__previewAnimations.push({ name: event.animationName, cardId: card.querySelector('[data-card-id]')?.getAttribute('data-card-id'), time: performance.now() });
    });
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
  const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/games/${checkpoint.id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  await page.locator('.game-shell').waitFor();
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  assert.equal(await page.locator(previewSelector).count(), 0, 'Resuming must not reveal historical opponent cards.');
}
async function clickAction(action) {
  const prompt = view.prompt;
  if (action.type === 'button') {
    if (prompt.number && /^\d+$/.test(String(action.arg))) {
      await page.locator('#prompt-number').fill(String(action.arg));
      return page.locator('.number-prompt button').click();
    }
    if (prompt.dropdown?.includes(action.arg)) {
      await page.locator('.number-prompt select').selectOption(action.arg);
      return page.locator('.number-prompt button').click();
    }
    const buttons = prompt.buttons.filter(button => button.command !== 'statefulPromptResults' && !(prompt.number && /^\d+$/.test(button.arg)) && !prompt.dropdown?.includes(button.arg));
    const index = buttons.findIndex(button => String(button.arg) === String(action.arg));
    assert.ok(index >= 0, `No displayed button for ${action.arg}: ${prompt.title}`);
    if (await page.locator('.prompt-choice-body').count()) await page.getByRole('dialog').last().locator('.prompt-modal-actions > button').nth(index).click();
    else await page.locator('.prompt-buttons > button').nth(index).click();
    if (/claim.*initiative/i.test(`${action.arg}${buttons[index].text}`)) await page.getByRole('dialog', { name: 'Claim initiative?', exact: true }).getByRole('button', { name: 'Claim initiative', exact: true }).click();
    return;
  }
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
  assert.fail(`Unexpected action ${action.type}`);
}
async function act(action) {
  const previous = view;
  const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`) && response.request().method() === 'POST');
  responsePromise.catch(() => {});
  await clickAction({ ...action, version: view.version, promptId: view.prompt.id });
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  assert.deepEqual(view.warnings, []);
  const sequence = Math.max(0, ...(previous.publicPlayEvents || []).map(event => event.sequence));
  return (view.publicPlayEvents || []).filter(event => event.sequence > sequence);
}
async function ready(event) {
  const preview = page.locator(`${previewSelector}[data-preview-card-id="${event.card.uuid}"][data-preview-ready="true"]`);
  await preview.waitFor({ timeout: 12_000 });
  await page.waitForFunction(id => window.__previewTimeline.some(item => item.cardId === id && item.ready), event.card.uuid);
  return preview;
}
async function layout(label) {
  const dimensions = await page.locator(previewSelector).evaluate(element => {
    const box = element.getBoundingClientRect();
    const visible = [...element.querySelectorAll('img, h2, h3, [data-preview-card-name]')].filter(node => node.getClientRects().length).map(node => { const rect = node.getBoundingClientRect(); return { tag: node.tagName, text: node.tagName === 'IMG' ? '' : node.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }; });
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, bounds: { top: box.top, bottom: box.bottom, left: box.left, right: box.right }, visible };
  });
  assert.ok(dimensions.scrollWidth <= dimensions.viewport.width + 1 && dimensions.scrollHeight <= dimensions.viewport.height + 1, `Preview page overflow: ${JSON.stringify(dimensions)}`);
  for (const box of [dimensions.bounds, ...dimensions.visible]) assert.ok(box.top >= -1 && box.bottom <= dimensions.viewport.height + 1 && box.left >= -1 && box.right <= dimensions.viewport.width + 1, `Preview is clipped: ${JSON.stringify(dimensions)}`);
  report.viewports.push({ label, ...dimensions });
}
async function blocked() {
  assert.equal(await page.locator('[data-game-content]').evaluate(element => element.inert), true, 'The underlying table must be inert throughout the reveal.');
  assert.equal(await page.locator('.prompt-panel').getAttribute('aria-busy'), 'true');
  let mutationRequests = 0;
  const count = request => { if (request.method() === 'POST' && /\/api\/games\/[^/]+\/(actions|bot)$/.test(new URL(request.url()).pathname)) mutationRequests++; };
  page.on('request', count);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.waitForTimeout(50);
  page.off('request', count);
  assert.equal(mutationRequests, 0, 'Keyboard input during the reveal must not send a stale game action.');
  assert.equal(await page.locator(previewSelector).count(), 1, 'Escape must not skip the three-second reveal.');
}
async function completed(expected) {
  await page.locator(previewSelector).waitFor({ state: 'detached', timeout: expected.length * 6000 + 2000 });
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  const timeline = await page.evaluate(() => window.__previewTimeline);
  const starts = timeline.filter(entry => entry.cardId && entry.ready);
  assert.deepEqual(starts.map(entry => entry.cardId), expected.map(event => event.card.uuid), 'Each genuine opponent play must be highlighted in order, including repeated plays of the same card.');
  assert.deepEqual(starts.map(entry => entry.sequence), expected.map(event => event.id), 'Preview identity must follow successful plays rather than unique card UUIDs.');
  const durations = starts.map(start => {
    const index = timeline.indexOf(start);
    const end = timeline.slice(index + 1).find(entry => entry.sequence !== start.sequence || !entry.ready);
    assert.ok(end, 'A completed preview must have a recorded end.');
    const duration = Math.round(end.time - start.time);
    assert.ok(duration >= 2950 && duration < 5500, `The readable preview must remain for three seconds: ${duration} ms.`);
    return { card: expected[starts.indexOf(start)].card.name, durationMs: duration };
  });
  assert.equal(await page.locator('[data-game-content]').evaluate(element => element.inert), false);
  return durations;
}

try {
  const saved = await checkpoints();
  await resume(await newPage(), saved.single);
  const firstEvents = await act(saved.single.action);
  const first = firstEvents.filter(event => event.playerId === 'bot');
  assert.equal(first.length, 1);
  const preview = await ready(first[0]);
  assert.equal(await page.locator(cardSelector(first[0].card.uuid)).count(), 0, 'The opponent card must not arrive before its highlight.');
  await blocked();
  await layout('portrait 375x667');
  await page.screenshot({ path: `${output}/opponent-preview-portrait.png` });
  await page.waitForTimeout(1800);
  assert.equal(await preview.count(), 1, 'The reveal must remain visible before three seconds elapse.');
  assert.equal(await page.locator(cardSelector(first[0].card.uuid)).count(), 0);
  report.single = await completed(first);
  const entered = units(view).find(card => card.uuid === first[0].card.uuid);
  const destinationTab = page.getByRole('tab', { name: entered.zone === 'spaceArena' ? 'Space' : 'Ground', exact: true });
  assert.equal(await destinationTab.getAttribute('aria-selected'), 'true', 'The mobile table must switch to the revealed unit’s arena automatically.');
  await page.locator(cardSelector(first[0].card.uuid)).waitFor();
  await page.waitForFunction(id => window.__previewAnimations.some(event => event.cardId === id && event.name === 'swu-card-enter'), first[0].card.uuid);
  report.single[0].entryAnimation = true;
  report.single[0].automaticArena = entered.zone;
  await page.screenshot({ path: `${output}/opponent-on-table.png` });

  await clearSession();
  await resume(await newPage({ width: 844, height: 390 }), saved.queue);
  const queueEvents = (await act(saved.queue.action)).filter(event => event.playerId === 'bot');
  assert.ok(queueEvents.length >= 2, 'Early initiative should produce several real opponent plays in one HTTP response.');
  assert.ok(new Set(queueEvents.map(event => event.card.uuid)).size < queueEvents.length, 'The queue fixture must include a public replay of one card.');
  await ready(queueEvents[0]);
  await layout('landscape 844x390');
  await page.screenshot({ path: `${output}/opponent-preview-landscape.png` });
  for (const event of queueEvents) assert.equal(await page.locator(cardSelector(event.card.uuid)).count(), 0, 'Queued cards must not arrive ahead of their own reveal.');
  await ready(queueEvents[1]);
  await blocked();
  assert.equal(await page.locator(cardSelector(queueEvents[1].card.uuid)).count(), 0);
  report.queue = await completed(queueEvents);
  for (const card of units(view).filter(card => queueEvents.some(event => event.card.uuid === card.uuid))) assert.equal(await page.locator(cardSelector(card.uuid)).count(), 1, 'The completed response must reach its real board.');

  await clearSession();
  await resume(await newPage(), saved.single);
  await page.route('**/*', route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
  const fallbackEvents = (await act(saved.single.action)).filter(event => event.playerId === 'bot');
  const fallback = await ready(fallbackEvents[0]);
  assert.equal(await fallback.locator('.opponent-play-art-fallback').count(), 1, 'Failed image loading must switch to the readable fallback.');
  assert.match(await fallback.innerText(), new RegExp(fallbackEvents[0].card.name), 'Unavailable artwork must preserve the public card name.');
  await page.screenshot({ path: `${output}/opponent-preview-artwork-fallback.png` });
  report.fallback = await completed(fallbackEvents);

  await clearSession();
  await resume(await newPage({ reducedMotion: 'reduce' }), saved.single);
  const reducedEvents = (await act(saved.single.action)).filter(event => event.playerId === 'bot');
  const reduced = await ready(reducedEvents[0]);
  const moving = await reduced.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1 && animation.effect?.getKeyframes().some(frame => ['transform', 'translate', 'rotate', 'scale', 'left', 'top'].some(key => frame[key] != null && !['none', '0px', '0deg', '1'].includes(String(frame[key]))))).map(animation => animation.animationName || 'transition'));
  assert.deepEqual(moving, [], 'Reduced motion must preserve the reading pause without moving effects.');
  report.reducedMotion = { moving, durations: await completed(reducedEvents) };

  await clearSession();
  await resume(await newPage(), saved.single);
  const resumedEvents = (await act(saved.single.action)).filter(event => event.playerId === 'bot');
  await ready(resumedEvents[0]);
  const latest = { id: view.id, token: view.sessionToken };
  await resume(page, latest);
  await page.waitForTimeout(3200);
  assert.equal(await page.locator(previewSelector).count(), 0);
  assert.equal(await page.locator(cardSelector(resumedEvents[0].card.uuid)).count(), 1, 'Reloading during the presentation must restore the authoritative board immediately.');
  assert.equal(await page.locator('.card-fx').count(), 0, 'Resuming must not replay old entry effects.');
  report.resume = { interruptedPreview: true, restoredLatestBoard: true, replayedHistory: false };

  await clearSession();
  await resume(await newPage(), saved.human);
  const humanEvents = await act(saved.human.action);
  assert.ok(humanEvents.some(event => event.playerId === 'human'));
  assert.equal(humanEvents.filter(event => event.playerId === 'bot').length, 0);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  assert.equal(await page.locator(previewSelector).count(), 0);
  const ownUnit = humanEvents.find(event => units(view).some(card => card.uuid === event.card.uuid));
  assert.ok(ownUnit);
  assert.equal(await page.locator(cardSelector(ownUnit.card.uuid)).count(), 1, 'A human play must arrive immediately without an opponent highlight.');
  assert.equal((await page.evaluate(() => window.__previewTimeline)).filter(event => event.cardId).length, 0);
  report.humanOnly = { name: ownUnit.card.name, delayed: false };
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  fixture?.game.close();
  await clearSession().catch(() => {});
  for (const context of contexts) await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
