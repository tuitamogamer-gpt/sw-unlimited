const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chooseAction } = require('../server/bot.cjs');
const { assertPrivateView } = require('./smoke.cjs');
const origin = process.env.SWU_URL || 'http://localhost:3001';
async function request(path, method = 'GET', body) {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}
async function main() {
  const report = [];
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const created = await request('/api/games', 'POST', { deckId: 'sor-luke-skywalker', opponentDeckId: 'sor-darth-vader', difficulty });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    let view = created.data;
    const id = view.id;
    const invalid = await request(`/api/games/${id}/actions`, 'POST', { type: 'button', promptId: 'stale', arg: 'pass' });
    assert.equal(invalid.status, 409);
    const memory = {};
    let requests = 0;
    try {
      while (!view.winnerIds.length && requests < 500) {
        assertPrivateView(view);
        for (const decision of view.botHistory) assert.ok(['Odabir karte', 'Odluka', 'Raspodjela', 'Odabir učinka'].includes(decision.action), 'AI history must not expose private card labels');
        assert.equal(view.warnings.length, 0, view.warnings.join(';'));
        const decision = chooseAction(view, { difficulty, memory });
        assert.ok(decision?.action, `Missing human action at ${view.prompt.title}`);
        const next = await request(`/api/games/${id}/actions`, 'POST', decision.action);
        assert.equal(next.status, 200, JSON.stringify(next.data));
        view = next.data;
        requests++;
      }
      assert.ok(view.winnerIds.length, 'HTTP match must finish');
      report.push({ difficulty, requests, rounds: view.round, winners: view.winnerIds });
      console.log(report.at(-1));
    } finally { await request(`/api/games/${id}`, 'DELETE'); }
  }
  fs.writeFileSync('docs/validation-http.json', JSON.stringify({ passed: true, matches: report }, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
