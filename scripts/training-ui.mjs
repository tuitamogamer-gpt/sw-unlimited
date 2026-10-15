// Complete each guided exercise through the rendered board and real HTTP API.
// No public board, action response, or successful lesson is mocked here.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { app, initialize } = require('../server/index.cjs');
const { assertPrivateView } = require('./smoke.cjs');
const output = process.env.SWU_TRAINING_REPORT || '/tmp/swu-training-ui';
await mkdir(output, { recursive: true });
await initialize();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const report = { passed: false, exercises: [], restores: [], viewports: [], catalogRecovery: [], pageErrors: [] };
let page; let view;
const guidanceSelector = '.training-active-guidance, .training-guidance.complete';

async function receive(pending) {
  const response = await pending;
  assert.ok([200, 201].includes(response.status()), `${response.status()}: ${await response.text()}`);
  view = await response.json();
  assertPrivateView(view);
  assert.ok(view.training, 'The server must identify this authenticated training checkpoint.');
  await page.locator(guidanceSelector).waitFor();
  await page.waitForFunction(status => {
    return !!document.querySelector(status === 'complete' ? '.training-guidance.complete' : '.training-active-guidance');
  }, view.training.status);
}

async function startLesson(lessonId, click) {
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/training/${lessonId}`)
    && response.request().method() === 'POST');
  pending.catch(() => {});
  await click();
  await receive(pending);
  assert.equal(view.training.lessonId, lessonId);
  assert.equal(view.training.status, 'active');
}

async function act(action, click) {
  const oldVersion = view.version;
  assert.ok(view.legalActions.some(candidate => candidate.type === action.type
    && candidate.cardId === action.cardId && candidate.arg === action.arg));
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${view.id}/actions`)
    && response.request().method() === 'POST');
  pending.catch(() => {});
  await click();
  await receive(pending);
  assert.ok(view.version > oldVersion, 'A visible teaching choice must apply a real engine action.');
  assert.deepEqual(view.warnings, []);
}

function cardButton(action, scope = '.hand-cards') {
  return page.locator(`${scope} .game-card-click[data-card-id="${action.cardId}"]:visible`);
}

function promptButton(action) {
  return page.locator(`.prompt-panel button[data-action-arg="${action.arg}"]:visible`);
}

async function restore(label) {
  const before = { id: view.id, version: view.version, training: view.training,
    selected: view.prompt.selectedCardIds, resourceCount: view.players.human.resourceCount };
  await page.reload({ waitUntil: 'networkidle' });
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/games/${before.id}/state`)
    && response.request().method() === 'POST');
  pending.catch(() => {});
  await page.locator('.resume-button').click();
  await receive(pending);
  assert.equal(view.id, before.id);
  assert.equal(view.version, before.version);
  assert.deepEqual(view.training, before.training);
  assert.deepEqual(view.prompt.selectedCardIds, before.selected);
  assert.equal(view.players.human.resourceCount, before.resourceCount);
  report.restores.push({ label, lessonId: view.training.lessonId, version: view.version, status: view.training.status });
}

async function verifyLayout(label) {
  const result = await page.evaluate(() => {
    const guidance = document.querySelector('.training-active-guidance, .training-guidance.complete');
    const rect = guidance.getBoundingClientRect();
    const text = guidance.querySelector('p, .context-banner') || guidance;
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      guidance: { left: rect.left, right: rect.right, height: rect.height },
      instructionVisible: text.scrollHeight <= text.clientHeight + 1,
      buttonsNamed: [...guidance.querySelectorAll('button')].every(button => !!(button.getAttribute('aria-label') || button.textContent.trim())) };
  });
  assert.ok(result.scrollWidth <= result.width + 1, `${label}: the training board must not overflow horizontally: ${JSON.stringify(result)}`);
  assert.ok(result.guidance.left >= -1 && result.guidance.right <= result.width + 1 && result.guidance.height > 0);
  assert.equal(result.instructionVisible, true, 'The rule explanation must not be clipped.');
  assert.equal(result.buttonsNamed, true);
  report.viewports.push({ label, ...result });
}

async function finishResource(language) {
  let selected = view.legalActions.find(action => action.type === 'card');
  await act(selected, () => cardButton(selected).click());
  assert.equal(view.prompt.selectedCardIds.length, 1);
  await restore(`${language}-resource-selection`);
  selected = view.legalActions.find(action => action.type === 'card' && !view.prompt.selectedCardIds.includes(action.cardId));
  await act(selected, () => cardButton(selected).click());
  assert.equal(view.training.step, 2);
  assert.equal(view.training.status, 'active');
  const done = view.legalActions.find(action => action.arg === 'done');
  assert.ok(done);
  await act(done, () => promptButton(done).click());
  assert.equal(view.training.status, 'complete');
  assert.equal(view.players.human.resourceCount, 2);
  assert.equal(view.players.human.handCount, 4);
  report.exercises.push({ language, lessonId: 'resources', actualResources: 2, complete: true });
}

async function finishAmbush(language) {
  const play = view.legalActions.find(action => action.intent === 'play');
  assert.equal(play.label, 'Auzituck Liberator Gunship');
  await act(play, () => cardButton(play).click());
  assert.equal(view.training.step, 2);
  assert.equal(view.prompt.ability.label, 'Ambush');
  assert.equal(view.prompt.ability.sourceCard.exhausted, true);
  assert.deepEqual(view.prompt.buttons.map(button => button.arg), ['trigger']);
  // A native legal decline must still be rejected by the guided exercise.
  const version = view.version;
  const rejected = await page.evaluate(async current => {
    const response = await fetch(`/api/games/${current.id}/actions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'button', arg: 'pass',
        version: current.version, promptId: current.prompt.id, sessionToken: current.sessionToken }) });
    return { status: response.status, body: await response.json() };
  }, view);
  assert.equal(rejected.status, 400);
  assert.ok(rejected.body.error);
  await restore(`${language}-pending-ambush`);
  assert.equal(view.version, version, 'Rejected training choices must preserve the saved native prompt.');
  const trigger = view.legalActions.find(action => action.arg === 'trigger');
  await act(trigger, () => promptButton(trigger).click());
  assert.equal(view.training.step, 3);
  const target = view.legalActions.find(action => action.type === 'card');
  assert.equal(target.label, 'TIE/ln Fighter');
  assert.equal(view.legalActions.filter(action => action.type === 'card').length, 1);
  assert.equal(await page.locator('.base-target-label').count(), 0);
  await page.locator('.arenas[data-active-arena="space"]').waitFor();
  await verifyLayout(`${language}-ambush-target`);
  await page.screenshot({ path: `${output}/${language}-ambush-target.png` });
  const sourceId = view.prompt.attackerId;
  await act(target, () => cardButton(target, '.enemy-arena').click());
  assert.equal(view.training.status, 'complete');
  assert.ok(view.players.bot.discard.some(card => card.uuid === target.cardId));
  assert.equal(view.players.human.space.find(card => card.uuid === sourceId).exhausted, true);
  assert.equal(view.players.bot.base.damage, 0);
  report.exercises.push({ language, lessonId: 'space-ambush', realCombat: true, noBaseAttack: true, complete: true });
}

async function finishDeploy(language) {
  assert.equal(view.players.human.resourceCount, 6);
  assert.equal(view.players.human.readyResources, 0);
  const deploy = view.legalActions.find(action => action.intent === 'deploy');
  assert.ok(deploy);
  await act(deploy, () => page.locator(`.friendly-row .leader-mini>button[data-card-id="${deploy.cardId}"]`).click());
  const confirm = view.legalActions.find(action => action.type === 'button');
  assert.match(confirm.label, /^Deploy Luke Skywalker/);
  await act(confirm, () => promptButton(confirm).click());
  assert.equal(view.training.status, 'complete');
  assert.equal(view.players.human.leader.deployed, true);
  assert.equal(view.players.human.resourceCount, 6);
  assert.equal(view.players.human.readyResources, 0);
  assert.deepEqual(view.legalActions, []);
  await restore(`${language}-completed-deploy`);
  await verifyLayout(`${language}-lesson-complete`);
  await page.screenshot({ path: `${output}/${language}-lesson-complete.png` });
  assert.equal(await page.locator('.prompt-panel').count(), 0, 'A completed lesson shows its completion controls instead of a native action prompt.');
  report.exercises.push({ language, lessonId: 'leader-deploy', totalResources: 6, readyResources: 0, complete: true });
}

try {
  for (const { language, viewport } of [
    { language: 'en', viewport: { width: 1440, height: 1000 } },
    { language: 'sr', viewport: { width: 375, height: 812 } },
  ]) {
    const context = await browser.newContext({ viewport });
    page = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.addInitScript(selected => localStorage.setItem('swu-language', selected), language);
    let releaseFailure;
    const failureGate = new Promise(resolve => { releaseFailure = resolve; });
    const catalogRoute = `${origin}/api/training`;
    await page.route(catalogRoute, async route => {
      await failureGate;
      await route.fulfill({ status: language === 'en' ? 503 : 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(language === 'en' ? { error: 'Temporary metadata outage' } : { lessons: [{ id: 'resources' }] }) });
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('.training-selector').waitFor();
    await page.locator('.training-catalog-status[role="status"]').waitFor();
    assert.equal(await page.locator('.launch-button').isEnabled(), true, 'A training metadata outage must not block ordinary battles.');
    releaseFailure();
    await page.locator('.training-catalog-error[role="alert"]').waitFor();
    assert.equal(await page.locator('.training-start').count(), 0);
    const retry = page.locator('.training-catalog-error button');
    assert.ok((await retry.innerText()).trim());
    if (language === 'sr') assert.notEqual(await retry.innerText(), 'Retry training missions');
    await page.unroute(catalogRoute);
    const retried = page.waitForResponse(response => response.url() === catalogRoute);
    await retry.click();
    assert.equal((await retried).status(), 200);
    await page.locator('.training-start').first().waitFor();
    report.catalogRecovery.push({ language, failure: language === 'en' ? '503' : 'malformed', loadingVisible: true, retried: true });
    assert.equal(await page.locator('.training-start').count(), 3);
    assert.equal(await page.locator('.training-start').evaluateAll(buttons => buttons.every(button => !!button.getAttribute('aria-label'))), true);
    if (language === 'sr') assert.notEqual(await page.locator('.training-selector h2').innerText(), 'Training missions');
    await startLesson('resources', () => page.locator('.training-start').first().click());
    await verifyLayout(`${language}-resource-start`);
    await finishResource(language);
    await startLesson('space-ambush', () => page.locator('.training-next').click());
    await finishAmbush(language);
    await startLesson('leader-deploy', () => page.locator('.training-next').click());
    await finishDeploy(language);
    await page.locator('.training-exit').click();
    await page.locator('.training-selector').waitFor();
    assert.equal(await page.locator('.training-lesson-completed').count(), 3, 'Completed lessons stay visible in the chooser.');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.training-selector').waitFor();
    assert.equal(await page.locator('.training-lesson-completed').count(), 3, 'Lesson completion survives a browser refresh.');
    await context.close();
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
