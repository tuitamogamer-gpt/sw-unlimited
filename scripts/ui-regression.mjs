// Exercise deliberate human choices against the actual HTTP engine and built UI.
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
const output = process.env.SWU_SCREENSHOTS || '/tmp/swu-ui-regression';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const decks = readDecks();
let fixture;
let view;
const report = { passed: false, manualPlays: [], viewports: [], baseImages: false, englishDefault: false, serbianPersists: false, refreshResume: false };

async function checkViewport(label) {
  const layout = await page.evaluate(() => {
    const height = innerHeight, width = innerWidth;
    const elements = ['.game-topbar', '.opponent-row', '.friendly-row', '.hand-section', '.command-dock'];
    return { height, width, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
      elements: elements.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }) };
  });
  assert.ok(layout.scrollHeight <= layout.height + 1, `${label}: page scrolls vertically: ${JSON.stringify(layout)}`);
  assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: page scrolls horizontally`);
  for (const element of layout.elements) assert.ok(element.top >= -1 && element.bottom <= layout.height + 1 && element.height > 0, `${label}: ${element.selector} is outside the screen`);
  report.viewports.push({ label, width: layout.width, height: layout.height, fits: true });
}

async function action(click) {
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`) && response.request().method() === 'POST');
  pending.catch(() => {});
  await click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  assert.deepEqual(view.warnings, []);
  return view;
}
function clickCard(name) {
  const card = view.players.human.hand.find(card => card.name === name);
  assert.ok(card, `Expected ${name} in hand`);
  return page.locator(`.hand-card [data-card-id="${card.uuid}"]`).click();
}
function clickButton(arg) {
  const buttons = view.prompt.buttons.filter(button => button.command !== 'statefulPromptResults'
    && !(view.prompt.number && /^\d+$/.test(button.arg)) && !view.prompt.dropdown?.includes(button.arg));
  const index = buttons.findIndex(button => String(button.arg) === arg);
  assert.ok(index >= 0, `Expected button ${arg}`);
  return page.locator('.prompt-buttons > button').nth(index).click();
}

try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.getByRole('button', { name: 'Start battle', exact: true }).count(), 1);
  assert.equal(await page.locator('.deck-tile').count(), 18);
  assert.ok(!(await page.locator('body').innerText()).includes('karata'));
  report.englishDefault = true;

  // A deterministic, signed checkpoint uses the same process key as this local
  // HTTP worker. No test-only endpoint or seed control is added to production.
  fixture = await createRecord({ playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
    botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), difficulty: 'normal', seed: 'manual-human-play' });
  for (let step = 0; step < 120 && fixture.game.botView().legalActions.length; step++) {
    const decision = chooseAction(fixture.game.botView(), { difficulty: 'normal', memory: fixture.record.memory });
    await applyAction(fixture.record, fixture.game, decision.action, 'bot');
  }
  const token = sealRecord(fixture.record);
  await page.evaluate(({ id, token }) => { localStorage.setItem('swu-command-session', id); localStorage.setItem(`swu-command-state:${id}`, token); }, { id: fixture.record.id, token });
  await page.reload({ waitUntil: 'networkidle' });
  const resume = page.waitForResponse(response => response.url().endsWith(`/api/games/${fixture.record.id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  view = await (await resume).json();
  await page.locator('.game-shell').waitFor();
  await checkViewport('opening hand');
  await page.waitForFunction(() => [...document.querySelectorAll('.base-art img')].length === 2 && [...document.querySelectorAll('.base-art img')].every(img => img.complete && img.naturalWidth > 0));
  report.baseImages = true;

  await action(() => clickButton('keep'));
  assert.equal(view.prompt.stage, 'resource');
  assert.match(await page.locator('.prompt-panel').innerText(), /starting resources|Choose 2/i);
  await action(() => clickCard('Obi-Wan Kenobi'));
  await action(() => clickCard('General Dodonna'));
  await checkViewport('two resources selected');
  await page.screenshot({ path: `${output}/mobile-resource-selection.png` });
  await action(() => clickButton('done'));
  assert.equal(view.prompt.stage, 'action');
  const droid = view.players.human.hand.find(card => card.name === '2-1B Surgical Droid');
  assert.ok(droid.playable);
  assert.match(await page.locator(`.hand-card:has([data-card-id="${droid.uuid}"]) .card-action-label`).innerText(), /play/i);
  await clickCard('Yoda');
  assert.match(await page.locator('.card-notice').innerText(), /cost|resource/i);
  await action(() => clickCard('2-1B Surgical Droid'));
  assert.ok(view.players.human.ground.some(card => card.uuid === droid.uuid));
  assert.ok(!view.players.human.resources.some(card => card.uuid === droid.uuid));
  report.manualPlays.push(droid.name);
  await checkViewport('human played a unit');

  await page.getByRole('tab', { name: 'Space', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Space', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.arena-ground').isVisible(), false);
  await page.getByRole('tab', { name: 'Ground', exact: true }).click();

  // Ending actions is deliberate and explains why the opponent may keep playing.
  await clickButton('claimInitiative');
  const claim = page.getByRole('dialog', { name: 'Claim initiative?', exact: true });
  await claim.waitFor();
  assert.match(await claim.innerText(), /no more actions.*opponent may keep playing/i);
  await claim.getByRole('button', { name: 'Keep playing', exact: true }).click();
  assert.equal(await page.locator('.game-shell').getAttribute('data-stage'), 'action');
  await action(async () => { await clickButton('claimInitiative'); await page.getByRole('dialog', { name: 'Claim initiative?', exact: true }).getByRole('button', { name: 'Claim initiative', exact: true }).click(); });
  assert.equal(view.prompt.resourceSelection.canSkip, true);
  assert.match(await page.locator('.prompt-panel').innerText(), /optional|skip/i);
  await action(() => clickCard('Asteroid Sanctuary'));
  await action(() => clickButton('done'));
  assert.equal(view.round, 2);
  assert.equal(view.players.human.hand.find(card => card.name === 'Yoda').playable, true);
  await action(() => clickCard('Yoda'));
  assert.ok(view.log.some(entry => entry.text === 'Player plays Yoda'));
  report.manualPlays.push('Yoda');

  // Resolve Yoda's When Defeated draw after the bot's legal Open Fire response.
  const self = view.prompt.buttons.find(button => button.text === 'You');
  await action(() => clickButton(self.arg));
  const doneDrawing = view.prompt.buttons.find(button => button.text === 'Done');
  assert.ok(doneDrawing, 'The human confirms Yoda’s draw choice.');
  await action(() => clickButton(doneDrawing.arg));
  for (const size of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await checkViewport('round two');
    await page.screenshot({ path: `${output}/battle-${size.width}.png` });
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await page.locator('.game-topbar .language-select').selectOption('sr');
  assert.equal(await page.locator('html').getAttribute('lang'), 'sr-Latn');
  assert.match(await page.locator('.prompt-panel').innerText(), /Tvoja akcija|TVOJ POTEZ/i);
  await checkViewport('Serbian interface');
  const id = view.id, version = view.version;
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('html').getAttribute('lang'), 'sr-Latn');
  report.serbianPersists = true;
  const resumed = page.waitForResponse(response => response.url().endsWith(`/api/games/${id}/state`));
  await page.getByRole('button', { name: 'Nastavi poslednju partiju', exact: true }).click();
  const restored = await (await resumed).json();
  assert.equal(restored.id, id);
  assert.equal(restored.version, version);
  await page.locator('.game-shell').waitFor();
  report.refreshResume = true;
  await page.locator('.game-topbar .language-select').selectOption('en');
  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  fixture?.game.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
