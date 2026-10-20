import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const { createApplication } = require('../server/index.cjs');
const { createMemoryRoomAdapter } = require('../server/room-store.cjs');
const { assertPrivateView } = require('./smoke.cjs');
const adapter = createMemoryRoomAdapter();
const { app } = createApplication({ roomAdapter: adapter });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const output = '/tmp/swu-online-ui'; await mkdir(output, { recursive: true });
const report = { passed: false, actions: 0, pageErrors: [], lostResponseRecovered: false, mobile: false };
const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 1000 } }), browser.newContext({ viewport: { width: 390, height: 844 } })]);
const pages = await Promise.all(contexts.map(context => context.newPage()));
const [host, guest] = pages;
for (const page of pages) {
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.route(/https:\/\/(cdn\.swu-db\.com|fonts\.)/, route => route.abort());
  page.on('request', request => { if (/\/api\/rooms\/.+\/actions$/.test(request.url())) report.actions++; });
}
async function state(page) {
  const seat = await page.evaluate(() => JSON.parse(localStorage.getItem('swu-private-room-v1')));
  const response = await page.request.get(`${origin}/api/rooms/${seat.id}`, { headers: { 'x-room-key': seat.playerKey } });
  assert.equal(response.status(), 200); const value = await response.json();
  if (value.game) { assertPrivateView(value.game); assert.equal(value.game.sessionToken, undefined); }
  return value;
}
async function rendered(page, value) {
  await page.waitForFunction(revision => Number(document.querySelector('[data-room-revision]')?.getAttribute('data-room-revision')) >= revision, value.room.revision);
}
async function pick(page, view, action) {
  await rendered(page, view);
  const next = page.waitForResponse(response => response.url().endsWith('/actions') && response.request().method() === 'POST');
  if (action.type === 'card') await page.locator(`.game-card-click[data-card-id="${action.cardId}"]`).first().click();
  else await page.locator(`.prompt-buttons [data-action-arg="${action.arg}"]`).first().click();
  const response = await next; assert.equal(response.status(), 200); const result = await response.json();
  assert.equal(result.game.version, view.game.version + 1); return result;
}
try {
  await host.goto(origin);
  await host.getByRole('button', { name: 'Play a friend · Online 1v1', exact: true }).click();
  await host.getByRole('button', { name: 'Create private room', exact: true }).waitFor();
  await host.screenshot({ path: `${output}/desktop-lobby.png`, fullPage: true });
  await host.getByRole('button', { name: 'Create private room', exact: true }).click();
  const invitation = await host.locator('#room-invitation').inputValue();
  const hostSeat = await host.evaluate(() => JSON.parse(localStorage.getItem('swu-private-room-v1')));
  assert.ok(!invitation.includes(hostSeat.playerKey));
  await guest.goto(invitation);
  await guest.locator('#online-deck').selectOption('sor-darth-vader');
  await guest.screenshot({ path: `${output}/phone-invitation.png`, fullPage: true });
  await guest.getByRole('button', { name: 'Join room', exact: true }).click();
  await Promise.all(pages.map(page => page.locator('.game-shell').waitFor()));
  let states = await Promise.all(pages.map(state));
  assert.equal(states[0].game.players.human.leader.name, 'Luke Skywalker');
  assert.equal(states[1].game.players.human.leader.name, 'Darth Vader');
  for (const value of states) assert.equal(value.game.version, 0);
  for (let step = 0; step < 30; step++) {
    states = await Promise.all(pages.map(state));
    if (states[0].game.phase === 'action') break;
    const active = states.findIndex(value => value.game.legalActions.length);
    assert.ok(active >= 0); const value = states[active], game = value.game;
    const action = game.prompt.stage === 'resource'
      ? game.prompt.selectedCardIds.length < game.prompt.resourceSelection.max
        ? game.legalActions.find(action => action.type === 'card' && !game.prompt.selectedCardIds.includes(action.cardId))
        : game.legalActions.find(action => action.arg === 'done')
      : game.legalActions.find(action => action.arg === 'keep') || game.legalActions[0];
    await pick(pages[active], value, action);
  }
  states = await Promise.all(pages.map(state));
  assert.equal(states[0].game.phase, 'action');
  assert.equal(states[1].game.players.human.handCount, 4);
  assert.deepEqual(states[0].game.players.human.hand.map(card => card.uuid).filter(id => states[1].game.players.human.hand.some(card => card.uuid === id)), []);
  await Promise.all(pages.map((page, index) => rendered(page, states[index])));
  await guest.getByRole('button', { name: 'Switch to fan hand' }).click();
  await guest.getByRole('button', { name: 'Show hand', exact: true }).click();
  await guest.locator('#hand-fan-panel').waitFor();
  await guest.screenshot({ path: `${output}/phone-private-hand.png`, fullPage: true });
  await guest.keyboard.press('Escape');
  report.mobile = true;
  const active = states.findIndex(value => value.game.prompt.active), actor = pages[active];
  const before = states[active];
  const pass = before.game.legalActions.find(action => action.arg === 'pass'); assert.ok(pass);
  let intercepted = 0;
  await actor.route('**/api/rooms/*/actions', async route => {
    intercepted++; const committed = await route.fetch(); assert.equal(committed.status(), 200); await route.abort('failed');
  });
  await actor.locator('.prompt-buttons [data-action-arg="pass"]').click();
  await actor.waitForFunction(revision => Number(document.querySelector('[data-room-revision]')?.getAttribute('data-room-revision')) > revision, before.room.revision);
  const recovered = await state(actor); assert.equal(recovered.game.version, before.game.version + 1); assert.equal(intercepted, 1);
  await actor.unroute('**/api/rooms/*/actions'); report.lostResponseRecovered = true;
  const originalKey = await guest.evaluate(() => JSON.parse(localStorage.getItem('swu-private-room-v1')).playerKey);
  await guest.reload();
  await guest.getByRole('button', { name: 'Resume room', exact: true }).click();
  await guest.locator('.game-shell').waitFor();
  assert.equal(await guest.evaluate(() => JSON.parse(localStorage.getItem('swu-private-room-v1')).playerKey), originalKey);
  const beforeOffline = await state(guest);
  await contexts[1].setOffline(true);
  await guest.getByText('Reconnecting…', { exact: true }).waitFor({ timeout: 15_000 });
  await contexts[1].setOffline(false);
  await guest.evaluate(() => window.dispatchEvent(new Event('online')));
  await guest.getByText('Reconnecting…', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await state(guest)).game.version, beforeOffline.game.version);
  await guest.locator('.online-turn').getByRole('button', { name: 'Room options' }).click();
  await guest.getByRole('button', { name: 'Concede match', exact: true }).click();
  await guest.getByRole('dialog').getByRole('button', { name: 'Concede match', exact: true }).click();
  await guest.getByRole('dialog').waitFor({ state: 'hidden' });
  const finished = await state(host); assert.deepEqual(finished.game.winnerIds, ['human']);
  await rendered(host, finished);
  assert.match(await host.locator('.game-shell').innerText(), /Victory/i);
  await host.screenshot({ path: `${output}/desktop-complete.png`, fullPage: true });
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await guest.getByRole('combobox', { name: 'Language' }).selectOption('sr');
  await guest.getByRole('button', { name: 'Napravi novu sobu', exact: true }).waitFor();
  assert.deepEqual(report.pageErrors, []); report.passed = true;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(report));
