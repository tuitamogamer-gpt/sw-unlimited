// Run after npm run build. A complete native Luke/Vader replay is restored by
// the real API and opened in the built client; no public views are fabricated.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { createRecord, applyAction, sealRecord } = require('../server/replay.cjs');
const { captureReviewDecision, commitReviewDecision, publicReview } = require('../server/match-review.cjs');
const { chooseAction } = require('../server/bot.cjs');
const { readDecks, assertPrivateView } = require('./smoke.cjs');
const output = process.env.SWU_REVIEW_REPORT || '/tmp/swu-match-review-ui';
const HISTORY_KEY = 'swu-command-match-history';
const report = { passed: false, native: {}, languages: [], viewports: [], historyReload: false,
  historyRemoval: false, deletedFinishedGameResume: false, pageErrors: [] };
let page; let received;

async function finishedCheckpoint() {
  const decks = readDecks();
  const { record, game } = await createRecord({ playerDeck: decks.find(deck => deck.id === 'sor-luke-skywalker'),
    botDeck: decks.find(deck => deck.id === 'sor-darth-vader'), difficulty: 'normal', seed: 123 });
  const memory = { human: {}, bot: {} };
  try {
    for (let step = 0; step < 1500 && !game.view('human').ended; step++) {
      const view = ['human', 'bot'].map(seat => game.view(seat)).find(view => view.prompt.active);
      assert.ok(view, 'A native fixture decision must be available.');
      const action = chooseAction(view, { difficulty: 'normal', memory: memory[view.viewerId] }).action;
      assert.ok(action);
      const captured = captureReviewDecision(record, game, action, view.viewerId);
      applyAction(record, game, action, view.viewerId);
      commitReviewDecision(record, captured, game);
    }
    const view = game.view('human');
    const review = publicReview(record, game);
    assert.equal(view.ended, true);
    assert.deepEqual(view.winnerIds, ['human']);
    assert.equal(review.outcome, 'win');
    assert.equal(review.moments.length, 3, 'The genuine completed fixture has three reviewable moments.');
    assert.equal(review.stats.decisions, record.actions.filter(item => item.playerId === 'human').length);
    assert.equal(review.stats.baseDamage, view.publicDamageEvents.filter(event => event.playerId === 'human'
      && event.targetCard.uuid === view.players.bot.base.uuid).reduce((sum, event) => sum + event.amount, 0));
    const publicNames = new Set([view.players.bot.base, ...view.players.bot.leaders, ...view.players.bot.ground,
      ...view.players.bot.space, ...view.players.bot.discard, ...view.publicPlayEvents.map(event => event.card)]
      .filter(card => card && !card.hidden).map(card => card.name));
    const privateOnlyNames = [...new Set(game.view('bot').players.bot.hand.filter(card => !card.hidden)
      .map(card => card.name).filter(name => name && !publicNames.has(name)))];
    report.native = { successfulActions: record.actions.length, humanChoices: review.stats.decisions,
      rounds: view.round, outcome: review.outcome, moments: review.moments.map(moment => moment.kind),
      privateCardNamesChecked: privateOnlyNames.length };
    return { id: record.id, token: sealRecord(record), review, privateOnlyNames };
  } finally { game.close(); }
}

function reviewDialog(language) {
  return page.getByRole('dialog', { name: language === 'sr' ? 'Pregled partije' : 'Battle review', exact: true });
}

async function verifyReview(saved, language) {
  const dialog = reviewDialog(language);
  await dialog.waitFor();
  assert.equal(await dialog.locator('.match-review-header h2').innerText(), language === 'sr' ? 'Pobeda' : 'Victory');
  const values = await dialog.locator('.match-review-stats dd').allTextContents();
  assert.deepEqual(values.map(Number), [saved.review.stats.decisions, saved.review.stats.plays,
    saved.review.stats.deploys, saved.review.stats.baseDamage], 'The visible statistics match actual recorded native outcomes.');
  assert.deepEqual(await dialog.locator('.match-review-stats dt').allTextContents(), language === 'sr'
    ? ['Doneti izbori', 'Odigrane karte', 'Raspoređeni vođe', 'Šteta na protivničkoj bazi']
    : ['Choices made', 'Cards played', 'Leaders deployed', 'Damage to enemy base']);
  assert.equal(await dialog.locator('.match-review-moment').count(), 3);
  for (let index = 0; index < saved.review.moments.length; index++) {
    const text = await dialog.locator('.match-review-moment').nth(index).innerText();
    assert.ok(text.includes(saved.review.moments[index].card), 'Each rendered moment names its public source card.');
    if (saved.review.moments[index].target) assert.ok(text.includes(saved.review.moments[index].target));
  }
  const text = await dialog.innerText();
  for (const hiddenName of saved.privateOnlyNames) assert.ok(!text.includes(hiddenName), 'A card revealed only in the bot hand cannot appear in review copy.');
  assert.ok(!text.includes('swu1.') && !text.includes('swucard_'), 'The review does not display native checkpoints or opaque card IDs.');
  assert.equal(await dialog.locator('.match-review-limits').count(), 1);
  if (language === 'sr') assert.ok(!(await dialog.locator('.match-review-section-title').innerText()).includes('Key moments'));
  return { values: values.map(Number), moments: await dialog.locator('.match-review-moment').allTextContents() };
}

async function verifyLayout(label) {
  const facts = await page.locator('.modal:has(.match-review)').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const content = dialog.querySelector('.match-review');
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth, clientHeight: dialog.clientHeight, scrollHeight: dialog.scrollHeight },
      paragraphsUnclipped: [...content.querySelectorAll('p')].every(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1) };
  });
  assert.ok(facts.documentWidth <= facts.width + 1, `${label}: page must fit horizontally.`);
  assert.ok(facts.dialog.left >= -1 && facts.dialog.right <= facts.width + 1
    && facts.dialog.top >= -1 && facts.dialog.bottom <= facts.height + 1, `${label}: the review modal fits the viewport.`);
  assert.ok(facts.dialog.scrollWidth <= facts.dialog.clientWidth + 1, `${label}: review content must not overflow horizontally.`);
  assert.equal(facts.paragraphsUnclipped, true, 'Explanations wrap without clipping.');
  await page.locator('.match-review-moment').last().scrollIntoViewIfNeeded();
  const finalVisible = await page.locator('.match-review-moment').last().evaluate(node => {
    const rect = node.getBoundingClientRect(), parent = node.closest('.modal').getBoundingClientRect();
    return rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1;
  });
  assert.equal(finalVisible, true, 'The final key moment is reachable within the modal scroll area.');
  report.viewports.push({ label, ...facts });
}

await mkdir(output, { recursive: true });
await initialize();
const saved = await finishedCheckpoint();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  for (const { language, viewport } of [
    { language: 'en', viewport: { width: 1440, height: 1000 } },
    { language: 'sr', viewport: { width: 390, height: 844 } },
  ]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ language, id, token }) => {
      localStorage.setItem('swu-language', language);
      if (!localStorage.getItem('swu-command-session')) {
        localStorage.setItem('swu-command-session', id);
        localStorage.setItem(`swu-command-state:${id}`, token);
      }
    }, { language, id: saved.id, token: saved.token });
    page = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/games/${saved.id}/state`)
      && response.request().method() === 'POST');
    responsePromise.catch(() => {});
    await page.locator('.resume-button').click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    received = await response.json();
    assertPrivateView(received);
    assert.deepEqual(received.review, saved.review, 'The actual HTTP restore provides the native finished review.');
    assert.deepEqual(received.winnerIds, ['human']);
    assert.deepEqual(received.warnings, []);
    const victory = page.locator('.modal:has(.victory-content)');
    await victory.waitFor();
    await victory.getByRole('button', { name: language === 'sr' ? /Pregledaj ovu bitku/ : /Review this battle/ }).click();
    const before = await verifyReview(saved, language);
    await verifyLayout(`${language}-${viewport.width}x${viewport.height}`);
    await page.screenshot({ path: `${output}/${language}-review.png`, animations: 'disabled' });
    await reviewDialog(language).getByRole('button', { name: language === 'sr' ? 'Zatvori' : 'Close', exact: true }).click();
    await reviewDialog(language).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: language === 'sr' ? 'Nazad u komandu' : 'Back to command', exact: true }).first().click();
    await page.locator('.lobby').waitFor();
    const row = page.locator(`[data-history-game-id="${saved.id}"]`);
    await row.waitFor();
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), HISTORY_KEY);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].review, saved.review, 'Actual completion stores the same review in guest history.');
    if (language === 'en') {
      await page.reload({ waitUntil: 'networkidle' });
      await row.waitFor();
      report.historyReload = true;
    }
    await row.locator('.history-review-button').click();
    const historyReview = await verifyReview(saved, language);
    assert.deepEqual(historyReview, before, 'History reopens the same rendered facts as the finished game.');
    await page.keyboard.press('Escape');
    await reviewDialog(language).waitFor({ state: 'detached' });
    await row.getByRole('button', { name: language === 'sr' ? 'Ukloni pregled partije' : 'Remove battle review', exact: true }).click();
    await row.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), HISTORY_KEY), []);
    report.historyRemoval = true;
    if (language === 'en') {
      // A new app instance sees the same saved finished checkpoint. Resuming it
      // must keep the local deletion intent instead of writing history again.
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await row.count(), 0, 'Deleted history remains absent after reloading the lobby.');
      const resumed = page.waitForResponse(response => response.url().endsWith(`/api/games/${saved.id}/state`)
        && response.request().method() === 'POST');
      resumed.catch(() => {});
      await page.locator('.resume-button').click();
      const response = await resumed;
      assert.equal(response.status(), 200, await response.text());
      received = await response.json();
      assertPrivateView(received);
      assert.deepEqual(received.review, saved.review, 'The deleted history entry still has its actual completed native checkpoint.');
      assert.deepEqual(received.winnerIds, ['human']);
      await victory.waitFor();
      await victory.getByRole('button', { name: 'Close', exact: true }).click();
      await victory.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Back to command', exact: true }).first().click();
      await page.locator('.lobby').waitFor();
      assert.equal(await row.count(), 0, 'Resuming the same finished game must not resurrect a deleted battle review.');
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), HISTORY_KEY), []);
      report.deletedFinishedGameResume = true;
    }
    report.languages.push({ language, translatedMetrics: true, actualReviewAndHistoryMatch: true, reviewRemoved: true });
    await context.close();
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.message;
  await page?.screenshot({ path: `${output}/failure.png`, animations: 'disabled' }).catch(() => {});
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  if (received?.sessionToken) await fetch(`${origin}/api/games/${saved.id}`, { method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: received.sessionToken }) }).catch(() => {});
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
