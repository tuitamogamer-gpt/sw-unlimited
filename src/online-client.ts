import type { AccountStorage } from './account/storage';
import type { Deck, GameAction, GameView, SavedCustomDeck } from './types';

export const ROOM_KEY = 'swu-private-room-v1';
const ID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const invitationPattern = new RegExp(`^(${ID})\\.([A-Za-z0-9_-]{43})$`, 'i');
export interface Invitation { id: string; inviteKey: string }
export interface RoomSnapshot {
  room: { id: string; revision: number; status: 'waiting' | 'active' | 'finished' | 'cancelled'; expiresAt: number;
    seat: 'host' | 'guest'; yourDeck: string; opponentDeck: string; opponentJoined: boolean };
  game?: GameView;
}
interface SavedSeat { id: string; playerKey: string; inviteKey?: string; pending?: { path: string; body: Record<string, unknown> } }
export class RoomRequestError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}
export function parseInvitation(input: string): Invitation | null {
  const value = input.trim();
  const token = value.includes('#') ? value.slice(value.indexOf('#') + 1).replace(/^join=/, '') : value.replace(/^join=/, '');
  const match = invitationPattern.exec(token);
  return match ? { id: match[1], inviteKey: match[2] } : null;
}
const randomKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deckBody = (deck: Deck) => deck.custom ? { playerDeck: (deck as SavedCustomDeck).recipe } : { deckId: deck.id };

/** Seat credentials stay on this device, outside account/cloud save payloads.
 * Save before sending so a lost create/join response never loses the seat. */
export function createOnlineClient({ storage, fetcher = fetch }: { storage: AccountStorage; fetcher?: typeof fetch }) {
  let saved: SavedSeat | null = null;
  let persistent = true;
  try {
    const value = JSON.parse(storage.getItem(ROOM_KEY) || 'null');
    if (value && new RegExp(`^${ID}$`, 'i').test(value.id) && /^[A-Za-z0-9_-]{43}$/.test(value.playerKey)) saved = value;
  } catch { persistent = false; }
  function save(value: SavedSeat | null) {
    saved = value;
    try { if (value) storage.setItem(ROOM_KEY, JSON.stringify(value)); else storage.removeItem(ROOM_KEY); }
    catch { persistent = false; }
  }
  async function request<T>(path: string, body?: unknown, seat = saved): Promise<T | null> {
    let response: Response;
    try {
      response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', ...(seat ? { 'x-room-key': seat.playerKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new RoomRequestError('Connection interrupted. Reconnect to check the latest position.'); }
    if (response.status === 204) return null;
    let data;
    try { data = await response.json(); } catch { throw new RoomRequestError('The room could not be loaded. Try again.', response.status); }
    if (!response.ok) throw new RoomRequestError(typeof data?.error === 'string' ? data.error : 'The room could not be loaded. Try again.', response.status);
    return data as T;
  }
  async function resume(): Promise<RoomSnapshot> {
    if (!saved) throw new RoomRequestError('No saved room on this device.');
    const seat = saved;
    const result = await request<RoomSnapshot>(seat.pending?.path || `/api/rooms/${seat.id}`, seat.pending?.body, seat);
    if (!result || result.room?.id !== seat.id) throw new RoomRequestError('The room could not be loaded. Try again.');
    if (seat.pending && saved === seat) { const { pending: _pending, ...ready } = seat; save(ready); }
    return result;
  }
  async function enter(deck: Deck, invitation?: Invitation) {
    if (saved) throw new RoomRequestError('Finish or leave your current room first.');
    const id = invitation?.id || crypto.randomUUID(), playerKey = randomKey(), inviteKey = invitation?.inviteKey || randomKey();
    const path = invitation ? `/api/rooms/${id}/join` : '/api/rooms';
    const body = { ...deckBody(deck), playerKey, inviteKey, ...(invitation ? {} : { id }) };
    save({ id, playerKey, ...(!invitation ? { inviteKey } : {}), pending: { path, body } });
    return resume();
  }
  return {
    hasSeat: () => !!saved,
    isPersistent: () => persistent,
    invitation: (origin: string) => saved?.inviteKey ? `${origin}/#join=${saved.id}.${saved.inviteKey}` : '',
    config: () => request<{ enabled: boolean }>('/api/rooms/config', undefined, null),
    create: (deck: Deck) => enter(deck),
    join: (deck: Deck, invitation: Invitation) => enter(deck, invitation),
    resume,
    poll: (revision: number) => {
      if (!saved) throw new RoomRequestError('No saved room on this device.');
      return request<RoomSnapshot>(`/api/rooms/${saved.id}?revision=${revision}`);
    },
    act: async (snapshot: RoomSnapshot, action: GameAction) => {
      if (!saved || saved.id !== snapshot.room.id || !snapshot.game) throw new RoomRequestError('No saved room on this device.');
      const { type, cardId, arg, result, promptId } = action;
      return (await request<RoomSnapshot>(`/api/rooms/${saved.id}/actions`, { revision: snapshot.room.revision, requestId: crypto.randomUUID(),
        action: { type, cardId, arg, result, promptId, version: snapshot.game.version } }))!;
    },
    leave: async (snapshot: RoomSnapshot) => {
      if (!saved || saved.id !== snapshot.room.id) throw new RoomRequestError('No saved room on this device.');
      return (await request<RoomSnapshot>(`/api/rooms/${saved.id}/leave`, { revision: snapshot.room.revision }))!;
    },
    forget: () => save(null),
  };
}
