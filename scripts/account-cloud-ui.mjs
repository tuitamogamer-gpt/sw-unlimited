// Browser Supabase SDK against a local signed auth provider, plus the real
// application, native game engine and account CAS store. No game/API response
// is mocked. This verifies integration; it does not contact a live Supabase project.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const express = require('express');
const { createAuthRouter } = require('../server/auth.cjs');
const { createApplication } = require('../server/index.cjs');
const { createAccountStore, createMemoryAccountAdapter } = require('../server/account-store.cjs');
const { chooseAction } = require('../server/bot.cjs');
const output = process.env.SWU_ACCOUNT_CLOUD_REPORT || '/tmp/swu-account-cloud-ui';
const publicKey = 'sb_publishable_local_browser_fixture_key';
const authSecret = randomBytes(32);
const password = 'local-browser-fixture-password';
const profiles = {
  a: { id: '11111111-2222-4333-8444-555555555555', email: 'alice@example.test', name: 'Alice Pilot' },
  b: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'bob@example.test', name: 'Bob Pilot' },
};
const owner = key => `supabase_${profiles[key].id}`;
const store = createAccountStore({ adapter: createMemoryAccountAdapter() });
const report = { passed: false, localAuthFixture: true, nativeSupabaseBrowserSDK: true, nativeGames: true,
  durableProductionStore: false, checks: [], pageErrors: [], authCalls: { password: 0, user: 0, logout: 0 }, screenshots: [] };
const refreshTokens = new Map();
const revoked = new Set();
let origin;
function profile(key) {
  const value = profiles[key];
  return { id: value.id, aud: 'authenticated', role: 'authenticated', email: value.email,
    email_confirmed_at: '2026-01-01T00:00:00Z', confirmed_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { full_name: value.name },
    identities: [], is_anonymous: false };
}
function issueSession(key) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = { iss: `${origin}/auth/v1`, aud: 'authenticated', sub: profiles[key].id, role: 'authenticated',
    exp, iat: exp - 3600, jti: randomUUID() };
  const parts = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')];
  const unsigned = parts.join('.');
  const accessToken = `${unsigned}.${createHmac('sha256', authSecret).update(unsigned).digest('base64url')}`;
  const refreshToken = randomUUID(); refreshTokens.set(refreshToken, { key, jti: claims.jti });
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: 3600, expires_at: exp, user: profile(key) };
}
function verifiedBearer(req) {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.get('authorization') || '');
  if (!match) return null;
  try {
    const parts = match[1].split('.');
    if (parts.length !== 3) return null;
    const actual = Buffer.from(parts[2], 'base64url');
    const expected = createHmac('sha256', authSecret).update(parts.slice(0, 2).join('.')).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const key = Object.keys(profiles).find(key => profiles[key].id === claims.sub);
    return key && claims.iss === `${origin}/auth/v1` && claims.exp > Date.now() / 1000 && !revoked.has(claims.jti) ? { key, claims } : null;
  } catch { return null; }
}

const outer = express();
outer.use(express.json({ limit: '2mb' }));
outer.use('/auth/v1', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
outer.post('/auth/v1/token', (req, res) => {
  if (req.get('apikey') !== publicKey) return res.status(401).json({ message: 'Invalid API key' });
  if (req.query.grant_type === 'refresh_token') {
    const saved = refreshTokens.get(req.body.refresh_token);
    if (!saved || revoked.has(saved.jti)) return res.status(400).json({ error_code: 'refresh_token_not_found', msg: 'Invalid refresh token' });
    return res.json(issueSession(saved.key));
  }
  report.authCalls.password++;
  const key = Object.keys(profiles).find(key => profiles[key].email === req.body.email);
  if (req.query.grant_type !== 'password' || !key || req.body.password !== password) return res.status(400).json({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  return res.json(issueSession(key));
});
outer.get('/auth/v1/user', (req, res) => {
  report.authCalls.user++;
  const verified = verifiedBearer(req);
  if (req.get('apikey') !== publicKey || !verified) return res.status(401).json({ error_code: 'bad_jwt', msg: 'Invalid session' });
  return res.json(profile(verified.key));
});
outer.post('/auth/v1/logout', (req, res) => {
  report.authCalls.logout++;
  const verified = verifiedBearer(req);
  if (!verified) return res.status(401).json({ message: 'Invalid session' });
  revoked.add(verified.claims.jti);
  return res.status(204).end();
});
outer.get('/auth/v1/settings', (_req, res) => res.json({ external: { email: true, google: false }, disable_signup: false, mailer_autoconfirm: false }));
const server = outer.listen(0, '127.0.0.1'); await once(server, 'listening');
origin = `http://127.0.0.1:${server.address().port}`;
const auth = createAuthRouter({ config: () => ({ url: origin, supabaseUrl: origin, supabasePublicKey: publicKey, supabaseGoogleEnabled: false }) });
const application = createApplication({ auth, authenticate: auth.resolveAccount, accountStore: store, accountOrigin: origin });
outer.use(application.app);
await application.initialize();
await mkdir(output, { recursive: true });
const recipes = JSON.parse(await readFile(new URL('../data/starter-recipes.json', import.meta.url), 'utf8')).decks;
const starter = recipes.find(deck => deck.id === 'sor-luke-skywalker');
const browser = await chromium.launch({ headless: true });
const contexts = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function pass(name, facts = {}) { report.checks.push({ name, passed: true, ...facts }); process.stdout.write(`PASS ${name}\n`); }
async function waitSnapshot(key, predicate, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const saved = await store.read(owner(key));
    if (predicate(saved)) return saved;
    if (Date.now() >= deadline) throw new Error(`Cloud store did not reach: ${label}; revision=${saved.revision}`);
    await pause(100);
  }
}
async function newDevice(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' }); contexts.push(context);
  const page = await context.newPage(); page.setDefaultTimeout(25_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin); await page.locator('.lobby').waitFor();
  await page.locator('[data-account-trigger]:visible').first().waitFor();
  return { context, page };
}
const panel = page => page.locator('[data-account-panel]');
async function openAccount(page) {
  if (!await panel(page).count()) await page.locator('[data-account-trigger]:visible').first().click();
  await panel(page).waitFor();
}
async function closeAccount(page) {
  if (await panel(page).count()) await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });
}
async function login(page, key) {
  await openAccount(page); await page.locator('#account-email').fill(profiles[key].email); await page.locator('#account-password').fill(password);
  await panel(page).locator('[data-account-action="email-signin"]').click();
  await page.locator('[data-account-trigger][aria-label="Open account"]:visible').first().waitFor();
  await page.locator('.lobby').waitFor();
  assert.equal(await page.locator('[data-account-trigger]:visible').first().getAttribute('title'), `Account: ${profiles[key].name}`);
  await closeAccount(page);
}
async function logout(page) {
  await openAccount(page); await panel(page).locator('[data-account-action="signout"]').click();
  await page.locator('[data-account-trigger][aria-label="Sign in"]:visible').first().waitFor();
  await closeAccount(page); await page.locator('.lobby').waitFor();
}
async function settled(page) {
  await openAccount(page); await page.locator('[data-cloud-save-status="synced"]').waitFor(); await closeAccount(page);
}
async function command(page) {
  if (await page.locator('.lobby').count()) return;
  await page.locator('.game-topbar').getByRole('button', { name: 'Back to command', exact: true }).click();
  await page.locator('.lobby').waitFor();
}
async function responseAfter(page, predicate, action) {
  const [response] = await Promise.all([page.waitForResponse(predicate), action()]);
  return response;
}
async function importDeck(page, name) {
  const input = { metadata: { name }, leader: { id: starter.leader.id, count: 1 }, base: { id: starter.base.id, count: 1 }, deck: starter.deck, sideboard: [] };
  await page.getByRole('button', { name: 'Import a deck', exact: true }).click(); await page.locator('#custom-deck-input').fill(JSON.stringify(input));
  const response = await responseAfter(page, response => response.url() === `${origin}/api/decks/import`, () => page.getByRole('button', { name: 'Validate deck', exact: true }).click());
  assert.equal(response.status(), 200);
  const result = await response.json(); assert.deepEqual(result.errors, []);
  await page.locator('.cdi-save-panel select').selectOption('human'); await page.getByRole('button', { name: 'Save deck', exact: true }).click();
  await page.locator(`[data-custom-deck-id="${result.deck.id}"]`).waitFor();
  await page.locator('.cdi-root').waitFor({ state: 'detached' });
  return { id: result.deck.id, name };
}
async function chooseUIAction(page, view, action) {
  assert.ok(action, 'A native legal action must be available.');
  const selector = action.type === 'card' ? `.game-card-click[data-card-id="${action.cardId}"]:visible` : `.prompt-panel [data-action-arg="${action.arg}"]:visible`;
  const response = await responseAfter(page, response => response.url() === `${origin}/api/games/${view.id}/actions`, () => page.locator(selector).first().click());
  assert.equal(response.status(), 200); const next = await response.json();
  if (next.training?.status === 'complete') await page.locator('.training-guidance.complete').waitFor();
  else await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  return next;
}
function fingerprint(view) {
  const card = value => value && { uuid: value.uuid, name: value.name, hidden: value.hidden, damage: value.damage,
    remainingHp: value.remainingHp, exhausted: value.exhausted, deployed: value.deployed };
  const players = Object.fromEntries(Object.entries(view.players).map(([id, player]) => [id, { base: card(player.base), leader: card(player.leader),
    hand: player.hand.map(card), ground: player.ground.map(card), space: player.space.map(card), resources: player.resources.map(card), discard: player.discard.map(card),
    resourceCount: player.resourceCount, readyResources: player.readyResources, deckCount: player.deckCount, hasInitiative: player.hasInitiative }]));
  return createHash('sha256').update(JSON.stringify({ round: view.round, phase: view.phase, players, stage: view.prompt.stage, winnerIds: view.winnerIds })).digest('hex');
}
async function screenshot(page, name) {
  const target = `${output}/${name}.png`; await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target);
}

try {
  const first = await newDevice({ width: 1280, height: 900 });
  const second = await newDevice({ width: 390, height: 844 });
  await login(first.page, 'a');
  const deckA = await importDeck(first.page, 'Cloud fleet Alice');
  await first.page.locator('#difficulty').selectOption('hard');
  await waitSnapshot('a', saved => saved.decks.some(item => item.id === deckA.id && item.value?.name === deckA.name)
    && saved.preferences.value?.difficulty === 'hard', 'Alice deck and hard difficulty');
  await settled(first.page);
  let current = await (await responseAfter(first.page, response => response.url() === `${origin}/api/games` && response.request().method() === 'POST',
    () => first.page.getByRole('button', { name: 'Start battle', exact: true }).click())).json();
  for (let step = 0; step < 8 && ['initiative', 'mulligan', 'resource'].includes(current.prompt.stage); step++) {
    let action;
    if (current.prompt.stage === 'initiative') action = current.legalActions.find(action => action.label === 'Yourself');
    if (current.prompt.stage === 'mulligan') action = current.legalActions.find(action => action.arg === 'keep');
    if (current.prompt.stage === 'resource') action = current.prompt.selectedCardIds.length < 2
      ? current.legalActions.find(action => action.type === 'card' && !current.prompt.selectedCardIds.includes(action.cardId))
      : current.legalActions.find(action => action.arg === 'done');
    current = await chooseUIAction(first.page, current, action);
  }
  assert.equal(current.prompt.stage, 'action');
  await waitSnapshot('a', saved => saved.currentGame.value?.gameId === current.id, 'Alice native checkpoint');
  await settled(first.page);
  pass('native SDK login saves a validated custom deck, preferences and native game', { gameId: current.id });

  await login(second.page, 'a');
  await second.page.locator(`[data-custom-deck-id="${deckA.id}"]`).waitFor();
  assert.equal(await second.page.locator('#difficulty').inputValue(), 'hard');
  const restored = await (await responseAfter(second.page, response => response.url().endsWith(`/api/games/${current.id}/state`),
    () => second.page.getByRole('button', { name: 'Resume last game', exact: true }).click())).json();
  assert.equal(restored.id, current.id); assert.equal(fingerprint(restored), fingerprint(current), 'A fresh device resumes the same native board.');
  await second.page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  await screenshot(second.page, '01-mobile-resumed-board');
  pass('a separate device hydrates the collection and resumes an identical native board');

  await command(first.page); await command(second.page); await settled(second.page);
  await second.context.setOffline(true); await second.page.locator('#difficulty').selectOption('easy');
  await openAccount(second.page); await second.page.locator('[data-cloud-save-status="offline"]').waitFor();
  assert.equal((await store.read(owner('a'))).preferences.value.difficulty, 'hard');
  await first.page.locator('#difficulty').selectOption('normal');
  await waitSnapshot('a', saved => saved.preferences.value?.difficulty === 'normal', 'competing device preference');
  await second.context.setOffline(false); await panel(second.page).getByRole('button', { name: 'Retry sync', exact: true }).click();
  await second.page.locator('[data-cloud-save-status="conflict"]').waitFor();
  await screenshot(second.page, '02-explicit-preference-conflict');
  await second.page.getByRole('button', { name: 'Use account version', exact: true }).click();
  await second.page.locator('.lobby').waitFor(); assert.equal(await second.page.locator('#difficulty').inputValue(), 'normal');
  assert.equal((await store.read(owner('a'))).preferences.value.difficulty, 'normal');
  pass('offline competing edits keep both versions until the player chooses the account version');

  await closeAccount(first.page); await first.context.setOffline(true); await first.page.locator('#difficulty').selectOption('hard');
  await openAccount(first.page); await first.page.locator('[data-cloud-save-status="offline"]').waitFor();
  await first.context.setOffline(false); await panel(first.page).getByRole('button', { name: 'Retry sync', exact: true }).click();
  await waitSnapshot('a', saved => saved.preferences.value?.difficulty === 'hard', 'offline queue retry');
  await first.page.locator('[data-cloud-save-status="synced"]').waitFor(); await closeAccount(first.page);
  pass('a nonconflicting offline edit survives and syncs on retry');

  await logout(second.page); assert.equal(await second.page.locator('.custom-deck-identity strong').count(), 0);
  await login(second.page, 'b'); assert.equal(await second.page.locator('.custom-deck-identity strong').count(), 0);
  assert.equal(await second.page.locator('.resume-button').count(), 0);
  const deckB = await importDeck(second.page, 'Private fleet Bob');
  await waitSnapshot('b', saved => saved.decks.some(item => item.id === deckB.id && item.value?.name === deckB.name), 'Bob collection');
  const alice = await store.read(owner('a')); assert.equal(alice.decks.find(item => item.id === deckA.id).value.name, deckA.name);
  assert.deepEqual(await first.page.locator('.custom-deck-identity strong').allTextContents(), [deckA.name]);
  await logout(second.page); await login(second.page, 'a');
  assert.deepEqual(await second.page.locator('.custom-deck-identity strong').allTextContents(), [deckA.name]);
  pass('guest, Alice and Bob collections and checkpoints remain isolated across account switches');

  let training = await (await responseAfter(first.page, response => response.url() === `${origin}/api/training/resources`, async () => {
    await first.page.getByRole('button', { name: 'Start lesson: Choose your resources', exact: true }).click();
    await first.page.getByRole('button', { name: 'Start new game', exact: true }).click();
  })).json();
  for (let step = 0; step < 4 && training.training?.status !== 'complete'; step++) {
    const action = training.training.allowedActions.find(action => action.arg === 'done')
      || training.training.allowedActions.find(action => action.type === 'card' && !training.prompt.selectedCardIds.includes(action.cardId));
    training = await chooseUIAction(first.page, training, action);
  }
  assert.equal(training.training?.status, 'complete');
  await waitSnapshot('a', saved => saved.training.value?.completedLessonIds?.includes('resources'), 'verified training proof');
  await first.page.getByRole('button', { name: 'Back to Command', exact: true }).click();
  await second.page.reload(); await second.page.locator('.lobby').waitFor();
  await second.page.locator('.training-lesson').filter({ has: second.page.getByRole('heading', { name: 'Choose your resources', exact: true }) }).getByText('Completed', { exact: true }).waitFor();
  pass('a completed native training lesson syncs and appears completed on the other device');

  // Finish a native battle through its real legal-action HTTP endpoint. The UI
  // resumes that actual server board to record/render/sync its verified review.
  let battle = await (await responseAfter(first.page, response => response.url() === `${origin}/api/games` && response.request().method() === 'POST', async () => {
    await first.page.getByRole('button', { name: 'Start battle', exact: true }).click();
    await first.page.getByRole('button', { name: 'Start new game', exact: true }).click();
  })).json(); const memory = {};
  for (let step = 0; step < 450 && !battle.winnerIds.length; step++) {
    const choice = chooseAction(battle, { difficulty: 'hard', memory }); assert.ok(choice?.action);
    const response = await fetch(`${origin}/api/games/${battle.id}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...choice.action, sessionToken: battle.sessionToken }) });
    assert.equal(response.status, 200); battle = await response.json();
  }
  assert.ok(battle.winnerIds.length, 'The native battle finishes within the bounded action budget.');
  await command(first.page);
  const completed = await (await responseAfter(first.page, response => response.url().endsWith(`/api/games/${battle.id}/state`),
    () => first.page.getByRole('button', { name: 'Resume last game', exact: true }).click())).json();
  assert.ok(completed.review); assert.equal(completed.id, battle.id);
  await waitSnapshot('a', saved => saved.matches.some(item => item.id === battle.id && item.value?.review?.version === 1), 'native battle review proof', 40_000);
  await first.page.locator('.victory-content').getByRole('button', { name: /Review this battle/ }).click(); await first.page.locator('.match-review').waitFor();
  const reviewStats = await first.page.locator('.match-review-stats').innerText();
  await screenshot(first.page, '03-native-battle-review');
  await first.page.keyboard.press('Escape'); await command(first.page);
  await second.page.reload(); await second.page.locator('.lobby').waitFor();
  await second.page.locator(`[data-history-game-id="${battle.id}"] .history-review-button`).click(); await second.page.locator('.match-review').waitFor();
  assert.equal(await second.page.locator('.match-review-stats').innerText(), reviewStats);
  pass('a finished native battle produces a verified review that opens on another device', { rounds: completed.round, outcome: completed.review.outcome });

  await second.page.keyboard.press('Escape');
  await first.page.locator(`[data-history-game-id="${battle.id}"]`).getByRole('button', { name: 'Remove battle review', exact: true }).click();
  const deleted = await waitSnapshot('a', saved => saved.matches.some(item => item.id === battle.id && item.value === null && item.deleted), 'deleted native review tombstone');
  const deletedVersion = deleted.matches.find(item => item.id === battle.id).version;
  for (const [index, device] of [first, second].entries()) {
    await device.page.reload(); await device.page.locator('.lobby').waitFor();
    assert.equal(await device.page.locator(`[data-history-game-id="${battle.id}"]`).count(), 0, `Device ${index + 1}: deletion survives a reload.`);
    const resumedFinished = await (await responseAfter(device.page, response => response.url().endsWith(`/api/games/${battle.id}/state`),
      () => device.page.getByRole('button', { name: 'Resume last game', exact: true }).click())).json();
    assert.equal(resumedFinished.id, battle.id); assert.ok(resumedFinished.winnerIds.length);
    await device.page.locator('.victory-content').waitFor(); await device.page.keyboard.press('Escape');
    await command(device.page); await settled(device.page);
    assert.equal(await device.page.locator(`[data-history-game-id="${battle.id}"]`).count(), 0, `Device ${index + 1}: resuming the finished board does not recreate its deleted history entry.`);
    const tombstone = (await store.read(owner('a'))).matches.find(item => item.id === battle.id);
    assert.equal(tombstone.value, null); assert.equal(tombstone.deleted, true); assert.equal(tombstone.version, deletedVersion,
      `Device ${index + 1}: resuming a finished board must not overwrite the cloud deletion.`);
  }
  await screenshot(second.page, '04-deleted-review-stays-deleted');
  pass('a deleted finished review stays deleted after reload and resume on both devices');

  assert.deepEqual(report.pageErrors, []); report.passed = true;
} catch (error) {
  report.failure = error.stack || error.message;
  for (const [index, context] of contexts.entries()) for (const page of context.pages()) await screenshot(page, `failure-device-${index + 1}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close(); await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
