// Exercise custom decks and the full card catalog through the built browser UI.
// Run after npm run build; output stays outside the tracked workspace.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { decodeRecord } = require('../server/replay.cjs');
const source = JSON.parse(await readFile(new URL('../data/starter-recipes.json', import.meta.url), 'utf8'));
const starter = source.decks.find(deck => deck.id === 'sor-luke-skywalker');
const catalog = JSON.parse(await readFile(new URL('../data/card-catalog.json', import.meta.url), 'utf8'));
const originalCards = new Set(source.decks.flatMap(deck => deck.deck.map(card => String(card.cid))));
const output = process.env.SWU_CUSTOM_DECKS_REPORT || '/tmp/swu-custom-decks-ui';
await mkdir(output, { recursive: true });

function fixture(name, code) {
  const added = catalog.cards.find(card => card.code === code);
  assert.ok(added?.engineSupported, `${code} must have an available script`);
  assert.ok(!originalCards.has(String(added.engineId)), `${code} must exercise a card outside all starter decks`);
  const deck = starter.deck.map(row => ({ id: row.id === 'SOR_236' ? code : row.id, count: row.count }));
  assert.equal(deck.reduce((sum, row) => sum + row.count, 0), 50);
  return { metadata: { name, author: 'Browser regression' }, leader: { id: starter.leader.id, count: 1 }, base: { id: starter.base.id, count: 1 }, deck, sideboard: [] };
}
const humanFixture = fixture('Custom Guardian Patrol', 'SOR_061');
const botFixture = fixture('Custom Distant Patrol', 'SOR_060');
const textFixture = [
  `Name: ${botFixture.metadata.name}`, 'Leader', `1 ${botFixture.leader.id}`, 'Base', `1 ${botFixture.base.id}`, 'Main Deck',
  ...botFixture.deck.map(row => `${row.count} ${row.id}`), 'Sideboard',
].join('\n');
const report = { passed: false, invalidCounts: [], jsonUpload: false, textImport: false, savedDecksPersist: false,
  bothCustomSeats: false, playedUnit: null, checkpointIndependentOfCollection: false, dismissedPendingChoices: false,
  catalog: {}, actions: 0, modalViewports: [], pageErrors: [] };
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
page.setDefaultTimeout(20_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
let view;

async function screenshot(name) { await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' }); }
async function modalFits(label) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].filter(element => element.getBoundingClientRect().height > 0).map(element => {
    const box = element.getBoundingClientRect();
    return { label: element.getAttribute('aria-label') || element.getAttribute('aria-labelledby'), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
  }));
  assert.ok(boxes.length, `${label}: a dialog is open`);
  for (const box of boxes) assert.ok(box.left >= -1 && box.top >= -1 && box.right <= box.width + 1 && box.bottom <= box.height + 1, `${label}: dialog extends beyond the viewport: ${JSON.stringify(box)}`);
  report.modalViewports.push({ label, width: 375, height: 667, fits: true });
}
async function validateImport() {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/decks/import') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Validate deck', exact: true }).click();
  const response = await pending;
  const data = await response.json();
  await page.locator('.cdi-preview').waitFor();
  return { status: response.status(), data };
}
async function importFile(recipe, name = 'custom-deck.json') {
  const content = JSON.stringify(recipe, null, 2);
  await page.locator('.cdi-drop-area input[type="file"]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) });
  await page.waitForFunction(expected => document.querySelector('#custom-deck-input')?.value === expected, content);
  return validateImport();
}
async function openImport() {
  await page.getByRole('button', { name: 'Import a deck', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Import a deck', exact: true }).waitFor();
}
async function saveImport(seat, deck) {
  await page.locator('.cdi-save-panel select').selectOption(seat);
  await page.getByRole('button', { name: 'Save deck', exact: true }).click();
  await page.locator(`[data-custom-deck-id="${deck.id}"]`).waitFor();
  await page.waitForFunction(() => !document.querySelector('.cdi-root'));
}
async function settledCatalog() { await page.locator('.catalog-grid[aria-busy="false"]').waitFor(); }
async function closeInspector() {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ci-root'));
}
async function settledGame() {
  // A response may precede the opponent-card/damage presentation and React's
  // final prompt. Wait for the exact accepted checkpoint, not just any idle DOM.
  await page.waitForFunction(({ id, token }) =>
    localStorage.getItem(`swu-command-state:${id}`) === token
      && document.querySelector('.prompt-panel')?.getAttribute('aria-busy') === 'false'
      && !document.querySelector('[data-game-content]')?.hasAttribute('inert'),
  { id: view.id, token: view.sessionToken });
  if (view.prompt.number || view.prompt.dropdown?.length || view.prompt.displayCards?.length || view.prompt.distribution) {
    await page.locator('.prompt-choice-body').waitFor();
  }
}
async function returnToCommand() {
  await settledGame();
  const choices = page.locator('.prompt-choice-body');
  // A unit can enter an arena before its When Played choice is resolved. That
  // legitimate modal must be dismissed by its UI, not clicked through. Open the
  // same chooser on simpler draws when available. An exhausted board with only
  // Pass legal has no additional chooser to open or dismiss.
  if (!await choices.count() && await page.locator('.prompt-more-button').count()) {
    await page.locator('.prompt-more-button').click();
    await choices.waitFor();
  }
  if (await choices.count()) {
    await choices.getByRole('button', { name: 'Back to battlefield', exact: true }).click();
    await choices.waitFor({ state: 'detached' });
    report.dismissedPendingChoices = true;
  }
  await page.getByRole('button', { name: 'Back to command', exact: true }).click();
  await page.locator('.lobby').waitFor();
  assert.equal(await page.evaluate(id => localStorage.getItem(`swu-command-state:${id}`), view.id), view.sessionToken,
    'Closing the choice dialog and leaving the battlefield must not resolve a pending engine action');
}
async function clickEngineButton(arg) {
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
  const shown = prompt.buttons.filter(button => button.command !== 'statefulPromptResults'
    && !(prompt.number && /^\d+$/.test(button.arg)) && !prompt.dropdown?.includes(button.arg));
  const index = shown.findIndex(button => String(button.arg) === String(arg));
  assert.ok(index >= 0, `No displayed button for ${arg}: ${prompt.title}`);
  const activeDialog = page.getByRole('dialog').last();
  const choicesOpen = await page.locator('.prompt-choice-body').count();
  if (choicesOpen) await activeDialog.locator('.prompt-modal-actions > button').nth(index).click();
  else await page.locator('.prompt-buttons > button').nth(index).click();
  if (/claim.*initiative/i.test(`${arg}${shown[index].text}`)) {
    await page.getByRole('dialog', { name: 'Claim initiative?', exact: true }).getByRole('button', { name: 'Claim initiative', exact: true }).click();
  }
}
async function clickEngineAction(action) {
  if (action.type === 'button') return clickEngineButton(action.arg);
  if (action.type === 'card') {
    let target = page.locator(`button[data-card-id="${action.cardId}"]:visible`).first();
    if (!await target.count()) {
      const space = [...view.players.human.space, ...view.players.bot.space].some(card => card.uuid === action.cardId);
      const tab = page.getByRole('tab', { name: space ? 'Space' : 'Ground', exact: true });
      if (await tab.isVisible()) await tab.click();
      target = page.locator(`button[data-card-id="${action.cardId}"]:visible`).first();
    }
    if (!await target.count()) {
      await page.locator('.prompt-more-button').click();
      target = page.getByRole('dialog').last().locator(`button[data-card-id="${action.cardId}"]`).first();
    }
    await target.click();
    return;
  }
  if (action.type === 'perCard') {
    await page.locator(`button[data-action-arg="${action.arg}"][data-card-id="${action.cardId}"]`).click();
    return;
  }
  if (action.type === 'stateful') {
    for (const entry of action.result.valueDistribution) await page.locator(`[data-target-id="${entry.uuid}"] input`).fill(String(entry.amount));
    await page.getByRole('button', { name: 'Confirm distribution', exact: true }).click();
    return;
  }
  assert.fail(`Unexpected action type ${action.type}`);
}
async function playAction(action) {
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`) && response.request().method() === 'POST');
  pending.catch(() => {});
  await clickEngineAction(action);
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  view = await response.json();
  await settledGame();
  assert.deepEqual(view.warnings, [], 'Custom cards must resolve without a stuck AI turn');
  report.actions++;
}

try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('.deck-tile').count(), 18, 'All starter decks remain available');

  // Filter and inspect a genuinely non-starter card, then return to the same search.
  await page.getByRole('button', { name: 'Card library', exact: true }).first().click();
  await page.locator('.card-catalog').waitFor();
  await settledCatalog();
  const initialCatalog = await (await fetch(`${origin}/api/cards?limit=1`)).json();
  assert.ok(initialCatalog.summary.total >= 2000, 'The library contains the complete imported catalog');
  report.catalog.total = initialCatalog.summary.total;
  await page.getByRole('searchbox', { name: 'Search all cards', exact: true }).fill('Guardian of the Whills');
  await page.getByRole('combobox', { name: 'Card set', exact: true }).selectOption('SOR');
  await page.getByRole('combobox', { name: 'Card type', exact: true }).selectOption('unit');
  await page.getByRole('combobox', { name: 'Engine support', exact: true }).selectOption('supported');
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.catalog-card')];
    return document.querySelector('.catalog-grid')?.getAttribute('aria-busy') === 'false' && cards.length > 0 && cards.every(card => card.textContent.includes('Guardian of the Whills') && card.textContent.includes('SOR_'));
  });
  const matching = await page.locator('.catalog-card').count();
  await modalFits('filtered card library');
  await page.locator('.catalog-card').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const image = document.querySelector('.catalog-card img');
    return image?.complete && image.naturalWidth > 0;
  });
  report.catalog.artLoaded = true;
  await screenshot('catalog-card-mobile');
  await page.getByRole('searchbox', { name: 'Search all cards', exact: true }).scrollIntoViewIfNeeded();
  await screenshot('catalog-filtered-mobile');
  await page.locator('.catalog-card').first().click();
  await page.locator('.ci-root').waitFor();
  assert.match(await page.locator('.ci-root').innerText(), /Guardian of the Whills/);
  await modalFits('catalog card inspector');
  await closeInspector();
  assert.equal(await page.getByRole('searchbox', { name: 'Search all cards', exact: true }).inputValue(), 'Guardian of the Whills');
  assert.equal(await page.getByRole('combobox', { name: 'Card set', exact: true }).inputValue(), 'SOR');
  assert.equal(await page.locator('.catalog-card').count(), matching);
  report.catalog.filterAndInspectPreserveState = true;
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.card-catalog'));

  // Reject both deck-size and maximum-copy errors without exposing a save action.
  await openImport();
  const short = structuredClone(humanFixture); short.deck[0].count--;
  const tooShort = await importFile(short, 'invalid-49-cards.json');
  assert.equal(tooShort.status, 422);
  assert.ok(tooShort.data.errors.some(message => /50/.test(message)), JSON.stringify(tooShort.data));
  assert.match(await page.locator('.cdi-diagnostics.cdi-error').innerText(), /50/);
  assert.equal(await page.getByRole('button', { name: 'Save deck', exact: true }).count(), 0);
  report.invalidCounts.push('49-card main deck rejected');
  const tooMany = structuredClone(humanFixture); tooMany.deck[0].count++; tooMany.deck[2].count--;
  const overCopies = await importFile(tooMany, 'invalid-four-copies.json');
  assert.equal(overCopies.status, 422);
  assert.ok(overCopies.data.errors.some(message => /copies|three|3\b/i.test(message)), JSON.stringify(overCopies.data));
  assert.equal(await page.getByRole('button', { name: 'Save deck', exact: true }).count(), 0);
  report.invalidCounts.push('four copies of one identity rejected');
  await modalFits('invalid deck diagnostics');
  await screenshot('import-invalid-copies-mobile');

  const human = await importFile(humanFixture, 'custom-guardian-patrol.json');
  assert.equal(human.status, 200, JSON.stringify(human.data));
  assert.deepEqual(human.data.errors, []);
  assert.ok(human.data.deck.custom && human.data.deck.validation.valid);
  assert.ok(human.data.deck.cards.some(({ card, count }) => card.name === 'Guardian of the Whills' && count === 3));
  await page.locator('.cdi-preview-status.is-valid').waitFor();
  await page.locator('.cdi-preview-status.is-valid').scrollIntoViewIfNeeded();
  await modalFits('valid custom deck preview');
  await screenshot('import-valid-json-mobile');
  await saveImport('human', human.data.deck);
  report.jsonUpload = true;

  await openImport();
  await page.locator('#custom-deck-input').fill(textFixture);
  const bot = await validateImport();
  assert.equal(bot.status, 200, JSON.stringify(bot.data));
  assert.deepEqual(bot.data.errors, []);
  assert.ok(bot.data.deck.cards.some(({ card, count }) => card.name === 'Distant Patroller' && count === 3));
  assert.notEqual(human.data.deck.id, bot.data.deck.id);
  await saveImport('bot', bot.data.deck);
  report.textImport = true;

  await page.reload({ waitUntil: 'networkidle' });
  for (const deck of [human.data.deck, bot.data.deck]) {
    await page.locator(`[data-custom-deck-id="${deck.id}"]`).waitFor();
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('swu-command-custom-decks')));
  assert.equal(saved.version, 1);
  assert.equal(saved.decks.length, 2);
  report.savedDecksPersist = true;
  await page.locator(`[data-custom-deck-id="${human.data.deck.id}"] [data-custom-seat="human"]`).click();
  await page.locator(`[data-custom-deck-id="${bot.data.deck.id}"] [data-custom-seat="bot"]`).click();
  const created = page.waitForResponse(response => response.url().endsWith('/api/games') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start battle', exact: true }).click();
  const started = await created;
  const sent = started.request().postDataJSON();
  assert.equal(sent.playerDeck.id, human.data.deck.id);
  assert.equal(sent.opponentDeck.id, bot.data.deck.id);
  assert.equal(started.status(), 201, await started.text());
  view = await started.json();
  await page.locator('.game-shell').waitFor();
  await settledGame();
  const openingRecord = decodeRecord(view.sessionToken);
  assert.equal(openingRecord.playerDeck.id, human.data.deck.id);
  assert.equal(openingRecord.opponentDeck.id, bot.data.deck.id);
  assert.deepEqual(openingRecord.playerDeck.deck, human.data.deck.recipe.deck);
  assert.deepEqual(openingRecord.opponentDeck.deck, bot.data.deck.recipe.deck);
  report.bothCustomSeats = true;

  // Choose only legal on-screen actions, including setup. The unit must enter an
  // arena, not resources; random shuffles cannot make this depend on one opener.
  const memory = {};
  while (!view.winnerIds.length && report.actions < 100 && !report.playedUnit) {
    const previous = view;
    const decision = chooseAction(view, { difficulty: 'normal', memory });
    assert.ok(decision?.action, `No legal human choice at ${view.prompt.title}`);
    const card = previous.players.human.hand.find(card => card.uuid === decision.action.cardId);
    await playAction(decision.action);
    if (card && [...view.players.human.ground, ...view.players.human.space].some(unit => unit.uuid === card.uuid)) {
      assert.ok(!view.players.human.resources.some(resource => resource.uuid === card.uuid));
      report.playedUnit = { name: card.name, code: card.code, round: view.round };
    }
  }
  assert.ok(report.playedUnit, 'A custom-deck human must be able to play a unit through the UI');
  await screenshot('custom-vs-custom-battle-mobile');
  const id = view.id, version = view.version, checkpoint = view.sessionToken;
  await returnToCommand();
  for (const deck of [human.data.deck, bot.data.deck]) {
    await page.locator(`[data-custom-deck-id="${deck.id}"] [data-custom-action="remove"]`).click();
    const confirmation = page.getByRole('dialog', { name: 'Remove custom deck?', exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: 'Remove deck', exact: true }).click();
    await page.waitForFunction(deckId => !document.querySelector(`[data-custom-deck-id="${deckId}"]`), deck.id);
  }
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('swu-command-custom-decks')).decks.length), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('swu-command-session')), id);
  // Evict the server's disposable in-memory instance. The next resume must
  // rebuild from the signed checkpoint, with neither deck in the collection.
  const removedInstance = await fetch(`${origin}/api/games/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: checkpoint }) });
  assert.equal(removedInstance.status, 204);
  await page.reload({ waitUntil: 'networkidle' });
  const resumed = page.waitForResponse(response => response.url().endsWith(`/api/games/${id}/state`));
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const resumeResponse = await resumed;
  assert.equal(resumeResponse.status(), 200, await resumeResponse.text());
  const restored = await resumeResponse.json();
  assert.equal(restored.id, id);
  assert.equal(restored.version, version);
  assert.deepEqual(restored.prompt, view.prompt, 'Resume preserves the pending engine choice after its dialog was dismissed');
  assert.deepEqual(restored.players.human.ground.map(card => card.uuid), view.players.human.ground.map(card => card.uuid));
  assert.deepEqual(restored.players.human.space.map(card => card.uuid), view.players.human.space.map(card => card.uuid));
  await page.locator('.game-shell').waitFor();
  report.checkpointIndependentOfCollection = true;
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await screenshot('failure').catch(() => {});
  await writeFile(`${output}/report.json`, JSON.stringify({ ...report, failure: error.message }, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
