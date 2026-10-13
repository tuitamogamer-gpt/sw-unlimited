// Run after npm run build. Exercise saved preferences and real cross-tab imports.
// Reports and screenshots stay outside the tracked workspace.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const recipes = JSON.parse(await readFile(new URL('../data/starter-recipes.json', import.meta.url), 'utf8'));
const starter = recipes.decks.find(deck => deck.id === 'sor-luke-skywalker');
const output = process.env.SWU_STORAGE_RECOVERY_REPORT || '/tmp/swu-storage-recovery-ui';
const PREFERENCES_KEY = 'swu-command-preferences';
const CUSTOM_DECKS_KEY = 'swu-command-custom-decks';
const report = { passed: false, preferences: [], crossTab: {}, pageErrors: [] };
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const pages = [];

function fixture(name, replacement) {
  return {
    metadata: { name, author: 'Storage browser regression' },
    leader: { id: starter.leader.id, count: 1 }, base: { id: starter.base.id, count: 1 },
    deck: starter.deck.map(row => ({ id: row.id === 'SOR_236' ? replacement : row.id, count: row.count })),
    sideboard: [],
  };
}
async function newPage(context, label) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.pageErrors.push({ page: label, message: error.message }));
  pages.push({ page, label });
  return page;
}
async function readyLobby(page) {
  await page.locator('.lobby').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.deck-tile').length === 18
    && document.querySelector('.launch-button')?.disabled === false);
}
const row = (page, id) => page.locator(`[data-custom-deck-id="${id}"]`);
async function collection(page, expected) {
  await page.waitForFunction(ids => {
    const actual = [...document.querySelectorAll('[data-custom-deck-id]')].map(node => node.dataset.customDeckId).sort();
    return JSON.stringify(actual) === JSON.stringify([...ids].sort());
  }, expected);
  const persisted = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).decks.map(deck => deck.id).sort(), CUSTOM_DECKS_KEY);
  assert.deepEqual(persisted, [...expected].sort());
}
async function importDeck(page, recipe, seat = 'save') {
  await page.getByRole('button', { name: 'Import a deck', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a deck', exact: true });
  await dialog.waitFor();
  await dialog.locator('#custom-deck-input').fill(JSON.stringify(recipe));
  const pending = page.waitForResponse(response => response.url().endsWith('/api/decks/import') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Validate deck', exact: true }).click();
  const response = await pending;
  const result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  await dialog.locator('.cdi-preview-status.is-valid').waitFor();
  await dialog.locator('.cdi-save-panel select').selectOption(seat);
  await dialog.getByRole('button', { name: 'Save deck', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await row(page, result.deck.id).waitFor();
  return result.deck;
}
async function removeDeck(page, id) {
  await row(page, id).locator('[data-custom-action="remove"]').click();
  const dialog = page.getByRole('dialog', { name: 'Remove custom deck?', exact: true });
  await dialog.getByRole('button', { name: 'Remove deck', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await row(page, id).waitFor({ state: 'detached' });
}

try {
  for (const [label, value] of [
    ['null', 'null'],
    ['array', '[]'],
    ['wrong field types', JSON.stringify({ deckId: 1, opponentDeckId: [], difficulty: {}, compact: 'yes', showLog: 'no' })],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: PREFERENCES_KEY, value });
    const page = await newPage(context, `preferences: ${label}`);
    await page.goto(origin, { waitUntil: 'networkidle' });
    await readyLobby(page);
    assert.equal(await page.locator('#difficulty').inputValue(), 'normal');
    const normalized = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), PREFERENCES_KEY);
    assert.equal(normalized.difficulty, 'normal');
    assert.equal(normalized.compact, false);
    assert.equal(normalized.showLog, true);
    assert.equal(typeof normalized.deckId, 'string');
    assert.equal(typeof normalized.opponentDeckId, 'string');
    report.preferences.push({ input: label, recovered: true, difficulty: normalized.difficulty });
    if (label === 'wrong field types') await page.screenshot({ path: `${output}/preferences-recovered.png`, animations: 'disabled' });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const first = await newPage(context, 'first tab');
  const second = await newPage(context, 'second tab');
  await first.goto(origin, { waitUntil: 'networkidle' });
  await second.goto(origin, { waitUntil: 'networkidle' });
  await readyLobby(first); await readyLobby(second);
  const firstRecipe = fixture('Shared Guardian Patrol', 'SOR_061');
  const a = await importDeck(first, firstRecipe, 'human');
  await collection(second, [a.id]);
  const b = await importDeck(second, fixture('Shared Distant Patrol', 'SOR_060'), 'human');
  await collection(first, [a.id, b.id]);
  await collection(second, [a.id, b.id]);
  report.crossTab.importsSynchronize = true;

  await row(second, a.id).locator('[data-custom-action="inspect"]').click();
  await second.locator(`.di-root[data-deck-id="${a.id}"]`).waitFor();
  const savedAt = await first.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key)).decks.find(deck => deck.id === id).savedAt,
    { key: CUSTOM_DECKS_KEY, id: a.id });
  const refreshed = await importDeck(first, firstRecipe);
  assert.equal(refreshed.id, a.id, 'Reimporting the same validated recipe updates its existing collection entry.');
  const updatedAt = await first.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key)).decks.find(deck => deck.id === id).savedAt,
    { key: CUSTOM_DECKS_KEY, id: a.id });
  assert.ok(updatedAt > savedAt);
  await collection(second, [a.id, b.id]);
  assert.equal(await second.locator(`.di-root[data-deck-id="${a.id}"]`).count(), 1);
  report.crossTab.reimportDoesNotDuplicate = true;

  await removeDeck(first, a.id);
  await collection(second, [b.id]);
  await second.locator('.di-root').waitFor({ state: 'detached' });
  await readyLobby(first); await readyLobby(second);
  report.crossTab.removedInspectorCloses = true;

  const c = await importDeck(second, fixture('Shared Wilderness Patrol', 'SOR_064'));
  await collection(first, [b.id, c.id]);
  await collection(second, [b.id, c.id]);
  report.crossTab.laterImportKeepsOtherDecksWithoutResurrection = true;

  await row(first, b.id).locator('[data-custom-action="remove"]').click();
  await first.getByRole('dialog', { name: 'Remove custom deck?', exact: true }).waitFor();
  await removeDeck(second, b.id);
  await first.getByRole('dialog', { name: 'Remove custom deck?', exact: true }).waitFor({ state: 'detached' });
  await collection(first, [c.id]); await collection(second, [c.id]);
  await readyLobby(first); await readyLobby(second);
  report.crossTab.removedConfirmationCloses = true;
  await first.screenshot({ path: `${output}/collection-first-tab.png`, animations: 'disabled' });
  await second.screenshot({ path: `${output}/collection-second-tab.png`, animations: 'disabled' });
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const { page, label } of pages) {
    if (!page.isClosed()) await page.screenshot({ path: `${output}/failure-${label.replace(/\W+/g, '-')}.png`, animations: 'disabled' }).catch(() => {});
  }
  await writeFile(`${output}/report.json`, JSON.stringify({ ...report, failure: error.message }, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
