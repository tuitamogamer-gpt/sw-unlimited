import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chooseAction } = require('../server/bot.cjs');
const origin = process.env.SWU_URL || 'http://localhost:3001';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('docs/screenshots', { recursive: true });
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.deck-tile').count(), 18);
  await page.screenshot({ path: 'docs/screenshots/command.png' });
  await page.getByRole('button', { name: 'Započni bitku', exact: true }).click();
  await page.locator('.game-shell').waitFor();
  // Leaders are visible before the initiative choice; hands are dealt afterward.
  await page.locator('.leader-mini .icon-button').first().click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  const id = await page.evaluate(() => localStorage.getItem('swu-command-session'));
  const sessionToken = await page.evaluate(id => localStorage.getItem(`swu-command-state:${id}`), id);
  let view = await page.evaluate(async ({ id, sessionToken }) => {
    const response = await fetch(`/api/games/${id}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });
    if (!response.ok) throw new Error(`Resume failed: ${response.status}`);
    return response.json();
  }, { id, sessionToken });
  const memory = {};
  let steps = 0;
  while (!view.winnerIds.length && steps < 400) {
    const decision = chooseAction(view, { difficulty: 'normal', memory });
    const action = decision.action;
    assert.ok(action, `No legal choice at ${view.prompt.title}`);
    const response = page.waitForResponse(res => res.url().endsWith(`/api/games/${id}/actions`) && res.request().method() === 'POST');
    response.catch(() => {});
    if (action.type === 'card') {
      let target = page.locator(`[data-card-id="${action.cardId}"]:visible`).first();
      if (!await target.count()) {
        const fallback = page.locator('details.legal-action-fallback');
        if (await fallback.count()) await fallback.evaluate(node => { node.open = true; });
        else await page.getByText('Dostupni ciljevi i odabiri').click();
        target = page.locator(`[data-card-id="${action.cardId}"]:visible`).first();
      }
      await target.click();
    } else if (action.type === 'button') {
      const buttons = view.prompt.buttons.filter(button => button.command !== 'statefulPromptResults'
        && !(view.prompt.number && /^\d+$/.test(button.arg)) && !view.prompt.dropdown?.includes(button.arg));
      const index = buttons.findIndex(button => String(button.arg) === String(action.arg));
      if (view.prompt.number && /^\d+$/.test(String(action.arg))) {
        await page.locator('#prompt-number').fill(String(action.arg));
        await page.locator('.number-prompt button').click();
      } else if (view.prompt.dropdown?.includes(action.arg)) {
        await page.locator('.number-prompt select').selectOption(action.arg);
        await page.locator('.number-prompt button').click();
      } else {
        assert.ok(index >= 0, `Browser smoke requires visible button ${action.arg}: ${JSON.stringify(view.prompt)}`);
        await page.locator('.prompt-buttons > button').nth(index).click();
      }
    } else {
      throw new Error(`Extend browser fixture for ${action.type}; engine suite covers this control.`);
    }
    const res = await response;
    assert.equal(res.status(), 200, await res.text());
    view = await res.json();
    await page.locator('.prompt-panel[aria-busy="false"]').waitFor();
    steps++;
    if (view.round >= 3 && !view.winnerIds.length && steps < 65) await page.screenshot({ path: 'docs/screenshots/battle.png' });
  }
  assert.ok(view.winnerIds.length, 'Browser-operated match must finish');
  assert.deepEqual(errors, []);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/screenshots/battle-mobile.png', fullPage: true });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(mobileOverflow, false, 'Mobile game must not overflow horizontally');
  await writeFile('docs/validation-browser.json', JSON.stringify({ passed: true, steps, rounds: view.round, winners: view.winnerIds,
    pageErrors: errors, mobileOverflow }, null, 2) + '\n');
  console.log({ passed: true, steps, rounds: view.round, winners: view.winnerIds, mobileOverflow });
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); }
