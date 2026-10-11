// Real Auth.js OAuth/cookie flow against a local signed Google test provider.
// UI data is created through the native deck/game APIs; no session success is mocked.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const express = require('express');
const { app: gameApp, initialize } = require('../server/index.cjs');
const { createAuthRouter } = require('../server/auth.cjs');
const { createMockGoogle } = require('../tests/helpers/mock-google.cjs');
const output = process.env.SWU_ACCOUNT_REPORT || '/tmp/swu-account-ui';
const source = JSON.parse(await readFile(new URL('../data/starter-recipes.json', import.meta.url), 'utf8'));
const starter = source.decks.find(deck => deck.id === 'sor-luke-skywalker');
const identities = {
  a: { sub: 'browser-pilot-alice', name: 'Alice Pilot', email: 'alice@example.test', email_verified: true },
  b: { sub: 'browser-pilot-bob', name: 'Bob Pilot', email: 'bob@example.test', email_verified: true },
};
const report = { passed: false, asset: null, nativeOAuth: true, oauthNavigations: 0, scopes: [], viewports: [], pageErrors: [] };
const ownedGames = new Map();
await mkdir(output, { recursive: true });
await initialize();
let origin;
const mock = await createMockGoogle({ origin: () => origin, clientId: 'browser-google-client', clientSecret: 'browser-google-secret' });
const outer = express();
outer.get('/mock/authorize', (req, res) => mock.authorize(req, res));
const server = outer.listen(0, '127.0.0.1');
await once(server, 'listening');
origin = `http://127.0.0.1:${server.address().port}`;
outer.use(await createAuthRouter({ config: { url: origin, secret: 'account-ui-native-oauth-secret-at-least-32-bytes', googleId: 'browser-google-client', googleSecret: 'browser-google-secret' }, oauthFetch: mock.oauthFetch }));
outer.use(gameApp);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
// The production client still permits only Google's real authorization host.
// Intercept its navigation at the provider boundary, leaving Auth.js state,
// PKCE, nonce, signed ID tokens, encrypted cookies, and all app APIs intact.
await page.route('https://accounts.google.com/**', route => {
  assert.ok(route.request().isNavigationRequest());
  report.oauthNavigations++;
  return route.fulfill({ status: 302, headers: { location: `${origin}/mock/authorize${new URL(route.request().url()).search}` } });
});
let view;

const trigger = () => page.locator('[data-account-trigger]:visible');
const panel = () => page.locator('[data-account-panel]');
const action = name => panel().locator(`[data-account-action="${name}"]`);
async function account() {
  return page.evaluate(async () => {
    const response = await fetch('/api/account');
    if (!response.ok) throw new Error(`Account request failed: ${response.status}`);
    return response.json();
  });
}
async function openAccount() {
  if (!await panel().count()) await trigger().click();
  await panel().waitFor();
}
async function closeAccount() {
  if (await panel().count()) await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'detached' });
}
async function login(identity) {
  mock.identity = identity;
  mock.cancel = false;
  await openAccount();
  const pending = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await action('signin').click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const data = await response.json();
  assert.equal(data.user?.id, `google_${createHash('sha256').update(identity.sub).digest('hex')}`);
  assert.equal(data.user?.name, identity.name);
  await page.locator('.lobby').waitFor();
  await page.locator('[data-account-trigger][aria-label="Open account"]:visible').waitFor();
  assert.ok((await context.cookies()).some(cookie => /session-token/.test(cookie.name) && cookie.httpOnly), 'The OAuth callback must issue a real HTTP-only session cookie.');
  return data.user;
}
async function logout({ failLookup = false } = {}) {
  await openAccount();
  if (failLookup) await page.route(`${origin}/api/account`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test post-signout account outage' }) }));
  const pending = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await action('signout').click();
  const response = await pending;
  if (failLookup) assert.equal(response.status(), 503);
  else assert.equal((await response.json()).user, null);
  await page.locator('.lobby').waitFor();
  await page.locator('[data-account-trigger][aria-label="Sign in"]:visible').waitFor();
  if (failLookup) {
    await page.unroute(`${origin}/api/account`);
    assert.equal((await account()).user, null, 'The native signout succeeds even if the following account status lookup fails.');
    report.successfulSignoutClearsIdentityDuringLookupFailure = true;
  }
  await closeAccount();
  assert.ok(!(await context.cookies()).some(cookie => /session-token/.test(cookie.name) && cookie.value), 'Signing out must remove the native session cookie.');
}
async function storageFingerprint(owner) {
  const values = await page.evaluate(ownerId => {
    const prefix = ownerId ? `swu-command-account:${ownerId}:` : '';
    const keys = ['swu-command-session', 'swu-command-custom-decks', 'swu-command-preferences'];
    const id = localStorage.getItem(prefix + keys[0]);
    if (id) keys.push(`swu-command-checkpoint:${id}`, `swu-command-state:${id}`);
    return keys.map(key => [key, localStorage.getItem(prefix + key)]);
  }, owner);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
async function fits(label, gameplay = false) {
  const facts = await page.evaluate(() => {
    const visible = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
    const header = [...document.querySelectorAll('.site-header, .game-topbar')].find(visible);
    const boxes = [...header.querySelectorAll('button,select')].filter(visible).map(element => {
      const box = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label') || element.textContent.trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const dialog = document.querySelector('[data-account-panel]')?.closest('[role="dialog"]')?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, boxes,
      dialog: dialog ? { left: dialog.left, top: dialog.top, right: dialog.right, bottom: dialog.bottom } : null };
  });
  assert.ok(facts.scrollWidth <= facts.width + 1, `${label}: horizontal overflow`);
  if (gameplay) assert.ok(facts.scrollHeight <= facts.height + 1, `${label}: the game must fit one screen`);
  for (const box of facts.boxes) assert.ok(box.left >= -1 && box.right <= facts.width + 1, `${label}: header control outside viewport: ${box.label}`);
  for (let index = 0; index < facts.boxes.length; index++) for (const other of facts.boxes.slice(index + 1)) {
    const current = facts.boxes[index];
    const overlap = Math.min(current.right, other.right) - Math.max(current.left, other.left);
    const sameRow = Math.min(current.bottom, other.bottom) - Math.max(current.top, other.top);
    assert.ok(overlap <= 1 || sameRow <= 1, `${label}: header controls overlap: ${current.label} / ${other.label}`);
  }
  if (facts.dialog) assert.ok(facts.dialog.left >= -1 && facts.dialog.top >= -1 && facts.dialog.right <= facts.width + 1 && facts.dialog.bottom <= facts.height + 1, `${label}: account dialog outside viewport`);
  report.viewports.push({ label, width: facts.width, height: facts.height, fits: true });
}
async function importDeck(name, replacement) {
  const recipe = { metadata: { name }, leader: { id: starter.leader.id, count: 1 }, base: { id: starter.base.id, count: 1 },
    deck: starter.deck.map(row => ({ id: row.id === 'SOR_236' && replacement ? replacement : row.id, count: row.count })), sideboard: [] };
  await page.getByRole('button', { name: 'Import a deck', exact: true }).click();
  await page.locator('#custom-deck-input').fill(JSON.stringify(recipe));
  const pending = page.waitForResponse(response => response.url() === `${origin}/api/decks/import`);
  await page.getByRole('button', { name: 'Validate deck', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert.deepEqual(result.errors, []);
  await page.locator('.cdi-save-panel select').selectOption('human');
  await page.getByRole('button', { name: 'Save deck', exact: true }).click();
  await page.locator(`[data-custom-deck-id="${result.deck.id}"]`).waitFor();
  await page.locator('.cdi-root').waitFor({ state: 'detached' });
  return { id: result.deck.id, name };
}
async function collection(expected) {
  const names = await page.locator('.custom-deck-identity strong').allTextContents();
  assert.deepEqual(names, expected.map(deck => deck.name), 'Only the current account’s imported decks should be visible.');
}
async function startGame() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const hold = async route => { await gate; await route.continue(); };
  if (!report.accountChangesBlockedWhileBusy) await page.route(`${origin}/api/games`, hold);
  const pending = page.waitForResponse(response => response.url() === `${origin}/api/games` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start battle', exact: true }).click();
  if (!report.accountChangesBlockedWhileBusy) {
    assert.equal(await trigger().isDisabled(), true, 'Account changes must be disabled while a game request is pending.');
    report.accountChangesBlockedWhileBusy = true;
  }
  release();
  const response = await pending;
  await page.unroute(`${origin}/api/games`, hold);
  assert.equal(response.status(), 201);
  view = await response.json();
  ownedGames.set(view.id, view);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  for (let count = 0; count < 2 && ['initiative', 'mulligan'].includes(view.prompt.stage); count++) {
    const legal = view.legalActions.find(candidate => candidate.arg === 'keep') || view.legalActions.find(candidate => candidate.label === 'Yourself') || view.legalActions[0];
    assert.equal(legal.type, 'button');
    const index = view.prompt.buttons.findIndex(button => String(button.arg) === String(legal.arg));
    assert.ok(index >= 0);
    const actionResponse = page.waitForResponse(item => item.url() === `${origin}/api/games/${view.id}/actions`);
    await page.locator('.prompt-buttons > button').nth(index).click();
    const accepted = await actionResponse;
    assert.equal(accepted.status(), 200);
    const next = await accepted.json();
    assert.ok(next.version > view.version);
    view = next; ownedGames.set(view.id, view);
    await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
  }
  return { id: view.id, version: view.version };
}
async function backToLobby() {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to command', exact: true }).click();
  await page.locator('.lobby').waitFor();
}
async function resume(saved) {
  const pending = page.waitForResponse(response => response.url() === `${origin}/api/games/${saved.id}/state`);
  await page.getByRole('button', { name: 'Resume last game', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  view = await response.json(); ownedGames.set(view.id, view);
  assert.equal(view.id, saved.id);
  assert.equal(view.version, saved.version);
  await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
}

try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  report.asset = await page.locator('script[type="module"][src]').getAttribute('src');
  assert.deepEqual((await account()).user, null);
  assert.equal(await page.locator('.deck-tile').count(), 18);
  await fits('Guest lobby 375×667');
  await openAccount();
  assert.ok(await action('guest').isVisible());
  await action('guest').click();
  await panel().waitFor({ state: 'detached' });
  const guestDeck = await importDeck('Guest Squadron');
  await page.locator('#difficulty').selectOption('easy');
  const guestGame = await startGame();
  await fits('Guest game 375×667', true);
  await page.setViewportSize({ width: 320, height: 667 });
  await fits('Guest game 320×667', true);
  await openAccount(); await fits('Guest account in game 320×667', true);
  await page.screenshot({ path: `${output}/guest-account-320.png`, animations: 'disabled' });
  await closeAccount();
  await backToLobby();
  let guestFingerprint = await storageFingerprint(null);

  const userA = await login(identities.a);
  await collection([]);
  assert.equal(await page.getByRole('button', { name: 'Resume last game', exact: true }).count(), 0);
  assert.equal(await page.locator('#difficulty').inputValue(), 'normal');
  assert.equal(await storageFingerprint(null), guestFingerprint, 'Signing in must leave legacy guest storage unchanged.');
  await openAccount();
  assert.ok((await panel().innerText()).includes(identities.a.name));
  assert.ok((await panel().innerText()).includes(identities.a.email));
  await fits('Signed-in profile 320×667');
  await page.screenshot({ path: `${output}/account-a-320.png`, animations: 'disabled' });
  await closeAccount();
  await page.locator('.site-header .language-select').selectOption('sr');
  await openAccount();
  assert.match(await action('signout').innerText(), /Odjav/i);
  await fits('Serbian profile 320×667');
  await page.screenshot({ path: `${output}/account-serbian-320.png`, animations: 'disabled' });
  await closeAccount();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal((await account()).user?.id, userA.id);
  assert.equal(await page.locator('html').getAttribute('lang'), 'sr-Latn');
  await page.locator('.site-header .language-select').selectOption('en');
  // Only this failure response is simulated; recovery returns to the real
  // account endpoint and must retain the already verified user and scope.
  await page.route(`${origin}/api/account`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test account service outage' }) }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await openAccount();
  await panel().getByText('Your account could not be checked. Guest play is still available. Try again when your connection is ready.', { exact: true }).waitFor();
  assert.ok((await panel().innerText()).includes(identities.a.name));
  await page.unroute(`${origin}/api/account`);
  const retry = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await action('retry').click();
  assert.equal((await (await retry).json()).user.id, userA.id);
  await closeAccount();
  report.accountFailureRetainedVerifiedIdentity = true;
  const aDeck = await importDeck('Alice Squadron', 'SOR_061');
  await page.locator('#difficulty').selectOption('hard');
  const aGame = await startGame();
  await fits('Signed-in game 320×667', true);
  await page.setViewportSize({ width: 375, height: 667 });
  await fits('Signed-in game 375×667', true);
  await openAccount(); await fits('Signed-in profile during game 375×667', true);
  await closeAccount();
  await backToLobby();
  const aFingerprint = await storageFingerprint(userA.id);
  // A misleading signout response must not manufacture a guest result when
  // the genuine status endpoint still verifies the original session cookie.
  await page.route(`${origin}/api/auth/signout`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: `${origin}/` }) }));
  await openAccount();
  const unchangedSession = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await action('signout').click();
  assert.equal((await (await unchangedSession).json()).user.id, userA.id);
  await page.locator('[data-account-trigger][aria-label="Open account"]:visible').waitFor();
  await openAccount();
  await panel().getByText('Sign-out could not be confirmed. Please try again.', { exact: true }).waitFor();
  await closeAccount();
  await page.unroute(`${origin}/api/auth/signout`);
  await collection([aDeck]);
  assert.equal(await storageFingerprint(userA.id), aFingerprint);
  assert.equal(await storageFingerprint(null), guestFingerprint);
  report.unconfirmedSignoutKeepsVerifiedAccount = true;
  await logout({ failLookup: true });
  await collection([guestDeck]);
  assert.equal(await page.locator('#difficulty').inputValue(), 'easy');
  assert.equal(await storageFingerprint(null), guestFingerprint);
  assert.equal(await storageFingerprint(userA.id), aFingerprint);
  await resume(guestGame); await backToLobby();
  guestFingerprint = await storageFingerprint(null);

  const userB = await login(identities.b);
  assert.notEqual(userB.id, userA.id);
  await collection([]);
  assert.equal(await page.getByRole('button', { name: 'Resume last game', exact: true }).count(), 0);
  assert.equal(await page.locator('#difficulty').inputValue(), 'normal');
  const bDeck = await importDeck('Bob Squadron', 'SOR_060');
  const bGame = await startGame();
  await backToLobby();
  const bFingerprint = await storageFingerprint(userB.id);
  await logout();
  const renamedA = await login({ ...identities.a, name: 'Alice Pilot Updated', email: 'alice-renamed@example.test' });
  assert.equal(renamedA.id, userA.id, 'Verified Google subject, not email/name, must determine the local account scope.');
  await collection([aDeck]);
  assert.equal(await page.locator('#difficulty').inputValue(), 'hard');
  assert.equal(await storageFingerprint(userA.id), aFingerprint);
  assert.equal(await storageFingerprint(userB.id), bFingerprint);
  assert.equal(await storageFingerprint(null), guestFingerprint);
  await resume(aGame); await backToLobby();
  await logout();
  await login(identities.b);
  await collection([bDeck]); await resume(bGame); await backToLobby();
  // Simulate a browser-expired/removed cookie, then ask the actual server to
  // verify the absent session. No account success or guest result is mocked.
  await context.clearCookies();
  const vanished = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await (await vanished).json()).user, null);
  await page.locator('[data-account-trigger][aria-label="Sign in"]:visible').waitFor();
  await collection([guestDeck]);
  assert.equal(await storageFingerprint(null), guestFingerprint);
  report.sessionCookieRemovalRestoredGuest = true;
  report.scopes = [{ name: 'Guest', restored: true }, { name: 'Alice', restored: true, nameEmailChangePreservedScope: true }, { name: 'Bob', restored: true }];
  report.noAutomaticMerge = true;
  report.sessionRefresh = true;
  report.profileEnglishSerbian = true;

  mock.cancel = true;
  await openAccount();
  const cancelled = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await action('signin').click();
  await cancelled;
  assert.equal((await account()).user, null);
  await page.locator('.lobby').waitFor();
  await openAccount();
  assert.match(await panel().innerText(), /cancel|try again/i);
  await page.screenshot({ path: `${output}/cancelled-login.png`, animations: 'disabled' });
  await closeAccount();
  await collection([guestDeck]);
  assert.equal(await storageFingerprint(null), guestFingerprint);
  report.cancelledLoginPreservedGuest = true;

  mock.cancel = false;
  mock.tokenError = true;
  await openAccount();
  const failedProvider = page.waitForResponse(response => response.url() === `${origin}/api/account`);
  await action('signin').click();
  await failedProvider;
  assert.equal((await account()).user, null);
  await page.locator('.lobby').waitFor();
  await openAccount();
  assert.match(await panel().innerText(), /could not be completed/i);
  await closeAccount();
  await collection([guestDeck]);
  assert.equal(await storageFingerprint(null), guestFingerprint);
  report.providerFailurePreservedGuest = true;

  assert.deepEqual(report.pageErrors, []);
  report.providerRequests = mock.counts;
  report.passed = true;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true, animations: 'disabled' }).catch(() => {});
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  for (const saved of ownedGames.values()) {
    const response = await fetch(`${origin}/api/games/${saved.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: saved.sessionToken }) });
    if (response.status !== 204) { console.error(`Owned game cleanup failed: ${response.status}`); process.exitCode = 1; }
  }
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
