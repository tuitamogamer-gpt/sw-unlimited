'use strict';

const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createRecord, applyAction, sealRecord, restoreRecord, SESSION_TTL } = require('./replay.cjs');
const { roomError, checkId } = require('./room-store.cjs');

const KEY = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
function keyHash(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw roomError(401, 'ROOM_ACCESS', 'This browser does not have access to that room.');
  return digest(key);
}
function matches(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function seatFor(room, key) {
  const hash = keyHash(key);
  if (matches(room.hostKey, hash)) return 'human';
  if (matches(room.guestKey, hash)) return 'bot';
  throw roomError(403, 'ROOM_ACCESS', 'This browser does not have access to that room.');
}
function checkBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw roomError(400, 'ROOM_INPUT', 'Invalid room request.');
  }
}

// The existing table always puts its viewer at the bottom. Normalize only
// ownership fields; private observations still come from game.view(actualSeat).
function perspective(view, seat, room) {
  const other = seat === 'human' ? 'bot' : 'human';
  const map = value => value === seat ? 'human' : value === other ? 'bot' : value;
  const normalized = JSON.parse(JSON.stringify({ ...view, players: { human: view.players[seat], bot: view.players[other] } }), (key, value) => {
    if (['id', 'viewerId', 'ownerId', 'controllerId', 'playerId', 'initiativePlayerId'].includes(key) && typeof value === 'string') return map(value);
    if (key === 'winnerIds' && Array.isArray(value)) return value.map(map);
    return value;
  });
  const names = text => typeof text === 'string' ? text.replace(/\b(Player|AI)\b/g, name => (name === 'Player' ? 'human' : 'bot') === seat ? 'You' : 'Opponent') : text;
  normalized.players.human.name = 'You'; normalized.players.bot.name = 'Opponent';
  normalized.log = normalized.log.map(entry => ({ ...entry, text: names(entry.text) }));
  normalized.prompt.title = names(normalized.prompt.title); normalized.prompt.subtitle = names(normalized.prompt.subtitle);
  normalized.multiplayer = { roomId: room.id, seat: seat === 'human' ? 'host' : 'guest', endedBy: room.endedBy || null };
  delete normalized.difficulty;
  if (room.endedBy === 'concede') {
    normalized.winnerIds = room.winnerIds.map(map);
    normalized.prompt = { ...normalized.prompt, active: false, stage: 'finished', title: room.winnerIds.includes(seat) ? 'Victory' : 'Defeat', buttons: [], selectedCardIds: [], selectableCardIds: [], displayCards: [] };
    normalized.legalActions = []; normalized.ended = true;
    normalized.log.push({ id: `concede-${room.revision}`, text: room.winnerIds.includes(seat) ? 'Opponent conceded.' : 'You conceded.' });
  }
  return normalized;
}

function createMultiplayerRouter({ adapter, getDecks, resolveDeck }) {
  const router = express.Router();
  const views = new Map();
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/api/rooms/config', (_req, res) => res.json({ enabled: !!adapter }));
  router.use('/api/rooms', (_req, _res, next) => next(adapter ? undefined : roomError(503, 'ROOM_DISABLED', 'Online play is temporarily unavailable. Solo play is ready.')));
  async function read(id) {
    checkId(id);
    const room = await adapter.read(id);
    if (!room) throw roomError(404, 'ROOM_NOT_FOUND', 'Room not found. Check the invitation link.');
    if (room.expiresAt <= Date.now()) throw roomError(410, 'ROOM_EXPIRED', 'This room has expired. Create a new room.');
    return room;
  }
  function cache(room, game) {
    if (views.size >= 30) views.delete(views.keys().next().value);
    const entry = { revision: room.revision, human: perspective(game.view('human'), 'human', room), bot: perspective(game.view('bot'), 'bot', room) };
    views.set(room.id, entry); return entry;
  }
  async function response(room, seat) {
    let game;
    if (room.checkpoint) {
      let cached = views.get(room.id);
      if (cached?.revision !== room.revision) {
        const restored = await restoreRecord(room.checkpoint, { decks: await getDecks() });
        try { cached = cache(room, restored.game); } finally { restored.game.close(); }
      }
      game = cached[seat];
    }
    return { room: { id: room.id, revision: room.revision, status: room.status, expiresAt: room.expiresAt,
      seat: seat === 'human' ? 'host' : 'guest', opponentJoined: !!room.guestKey,
      yourDeck: (seat === 'human' ? room.hostDeck : room.guestDeck)?.name || '',
      opponentDeck: (seat === 'human' ? room.guestDeck : room.hostDeck)?.name || '' }, ...(game ? { game } : {}) };
  }
  async function commit(room, next) {
    next.revision = room.revision + 1;
    if (!await adapter.compareAndSwap(room.id, room.revision, next)) throw roomError(409, 'ROOM_CHANGED', 'The room changed. Refresh before choosing your next action.');
  }
  router.post('/api/rooms', asyncRoute(async (req, res) => {
    checkBody(req.body, ['id', 'playerKey', 'inviteKey', 'deckId', 'playerDeck']);
    const { id, playerKey, inviteKey } = req.body; checkId(id);
    const hostKey = keyHash(playerKey), inviteHash = keyHash(inviteKey);
    if (hostKey === inviteHash) throw roomError(400, 'ROOM_INPUT', 'The room needs separate player and invitation keys.');
    const existing = await adapter.read(id);
    if (existing) { const room = await read(id); const seat = seatFor(room, playerKey); return res.json(await response(room, seat)); }
    const hostDeck = await resolveDeck(req.body);
    const room = { id, revision: 0, status: 'waiting', hostKey, inviteHash, hostDeck, guestKey: null, guestDeck: null,
      checkpoint: null, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL, requests: [] };
    if (!await adapter.compareAndSwap(id, null, room)) { const saved = await read(id); return res.json(await response(saved, seatFor(saved, playerKey))); }
    res.status(201).json(await response(room, 'human'));
  }));
  router.post('/api/rooms/:id/join', asyncRoute(async (req, res) => {
    checkBody(req.body, ['playerKey', 'inviteKey', 'deckId', 'playerDeck']);
    const room = await read(req.params.id), guestKey = keyHash(req.body.playerKey);
    if (matches(room.guestKey, guestKey) || matches(room.hostKey, guestKey)) return res.json(await response(room, seatFor(room, req.body.playerKey)));
    if (!matches(room.inviteHash, keyHash(req.body.inviteKey))) throw roomError(403, 'ROOM_INVITE', 'That invitation is not valid.');
    if (room.status !== 'waiting' || room.guestKey) throw roomError(409, 'ROOM_FULL', 'This room is full or closed. Ask for a new invitation.');
    if (guestKey === room.inviteHash) throw roomError(400, 'ROOM_INPUT', 'Use a separate private player key.');
    const guestDeck = await resolveDeck(req.body);
    const created = await createRecord({ playerDeck: room.hostDeck, botDeck: guestDeck });
    try {
      const next = { ...room, guestKey, guestDeck, status: 'active', checkpoint: sealRecord(created.record), expiresAt: created.record.expiresAt };
      await commit(room, next); cache(next, created.game);
      res.json(await response(next, 'bot'));
    } finally { created.game.close(); }
  }));
  router.get('/api/rooms/:id', asyncRoute(async (req, res) => {
    const room = await read(req.params.id); const seat = seatFor(room, req.get('x-room-key'));
    // Polling unchanged rooms reads only their revision; it does not replay or
    // transfer the complete board. Responses remain private and uncached.
    if (req.query.revision !== undefined && String(room.revision) === req.query.revision) return res.status(204).end();
    res.json(await response(room, seat));
  }));
  router.post('/api/rooms/:id/actions', asyncRoute(async (req, res) => {
    checkBody(req.body, ['revision', 'requestId', 'action']);
    const room = await read(req.params.id); const seat = seatFor(room, req.get('x-room-key'));
    const { revision, requestId, action } = req.body; checkId(requestId);
    checkBody(action, ['type', 'cardId', 'arg', 'result', 'promptId', 'version']);
    const fingerprint = digest(JSON.stringify({ seat, revision, action }));
    const previous = room.requests.find(item => item.id === requestId);
    if (previous) {
      if (previous.hash !== fingerprint) throw roomError(409, 'ROOM_REQUEST', 'This action request has already been used.');
      return res.json(await response(room, seat));
    }
    if (room.status !== 'active') throw roomError(409, 'ROOM_CLOSED', 'This room is not accepting moves.');
    if (revision !== room.revision || !Number.isSafeInteger(action.version)) throw roomError(409, 'ROOM_CHANGED', 'The room changed. Refresh before choosing your next action.');
    const restored = await restoreRecord(room.checkpoint, { decks: await getDecks() });
    try {
      const view = applyAction(restored.record, restored.game, action, seat);
      const next = { ...room, checkpoint: sealRecord(restored.record), status: view.winnerIds.length ? 'finished' : 'active',
        requests: [...room.requests.slice(-63), { id: requestId, hash: fingerprint }] };
      await commit(room, next); cache(next, restored.game);
      res.json(await response(next, seat));
    } finally { restored.game.close(); }
  }));
  router.post('/api/rooms/:id/leave', asyncRoute(async (req, res) => {
    checkBody(req.body, ['revision']);
    const room = await read(req.params.id); const seat = seatFor(room, req.get('x-room-key'));
    if (['finished', 'cancelled'].includes(room.status)) return res.json(await response(room, seat));
    if (req.body.revision !== room.revision) throw roomError(409, 'ROOM_CHANGED', 'The room changed. Refresh before leaving.');
    const next = { ...room, status: room.status === 'waiting' ? 'cancelled' : 'finished',
      endedBy: room.status === 'waiting' ? 'cancel' : 'concede', winnerIds: [seat === 'human' ? 'bot' : 'human'] };
    await commit(room, next); res.json(await response(next, seat));
  }));
  return router;
}
module.exports = { createMultiplayerRouter, perspective };
