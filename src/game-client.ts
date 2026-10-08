import type { GameAction, GameView } from './types';

export const SESSION_KEY = 'swu-command-session';
const TOKEN_PREFIX = 'swu-command-state:';
const CHECKPOINT_PREFIX = 'swu-command-checkpoint:';
const REQUEST_TIMEOUT_MS = 20_000;
const RECOVERY_TIMEOUT_MS = 8_000;

export const CLIENT_MESSAGES = {
  timeout: 'The request timed out. The server may still be processing it.',
  cancelled: 'The request was cancelled. An action already sent may still finish on the server.',
  network: 'The connection was interrupted. Check your connection and reconnect.',
  malformed: 'The server returned an incomplete response. Your saved game has been kept.',
  busy: 'This game is being updated in another request or tab. Wait a moment, then reconnect.',
  stale: 'A newer saved turn was found. The board was refreshed; review it before choosing another action.',
  recovered: 'The response was interrupted. A saved board was recovered; your last action may not be included. Review the board before continuing.',
  unrecovered: 'The action could not be confirmed. Reconnect before choosing another action; it will not be sent again automatically.',
  refresh: 'The saved board was refreshed. Review it before choosing another action.',
  storage: 'Browser storage is unavailable. Your game is kept in this tab; keep it open to continue.',
  unavailable: 'The server is unavailable. Try reconnecting.',
} as const;

export class GameClientError extends Error {
  status?: number;
  code: string;
  requiresRefresh: boolean;
  details?: unknown;
  constructor(message: string, options: { status?: number; code?: string; requiresRefresh?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'GameClientError';
    this.status = options.status;
    this.code = options.code || 'REQUEST_FAILED';
    this.requiresRefresh = options.requiresRefresh || false;
    this.details = options.details;
  }
}

type Checkpoint = { id: string; version: number; sessionToken: string };
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
type ClientOptions = {
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  locks?: Pick<LockManager, 'request'> | null;
  timeoutMs?: number;
  recoveryTimeoutMs?: number;
  recoveryDelayMs?: number;
};
export type GameUpdate = { view: GameView; notice?: string };

/** Checkpoints stay opaque. Only a monotonic public version is stored beside them. */
export function createGameClient(options: ClientOptions = {}) {
  const memory = new Map<string, Checkpoint>();
  const storageFailed = new Set<string>();
  const needsRefresh = new Set<string>();
  const pending = new Set<string>();
  let memorySession = '';
  const fetchRequest = options.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  function storage() {
    try { return options.storage === undefined ? globalThis.localStorage : options.storage; } catch { return null; }
  }
  function storedValue(key: string): string {
    try { return storage()?.getItem(key) || (key === SESSION_KEY ? memorySession : ''); } catch { return key === SESSION_KEY ? memorySession : ''; }
  }
  function savedCheckpoint(id: string): Checkpoint | undefined {
    let saved: Checkpoint | undefined;
    try {
      const value = JSON.parse(storedValue(`${CHECKPOINT_PREFIX}${id}`) || 'null');
      if (value?.id === id && Number.isSafeInteger(value.version) && value.version >= 0 && typeof value.sessionToken === 'string' && value.sessionToken.startsWith('swu1.')) saved = value;
    } catch { /* An incomplete old browser write cannot replace the in-memory checkpoint. */ }
    const current = memory.get(id);
    if (current && (!saved || current.version > saved.version || storageFailed.has(id) && current.version === saved.version)) return current;
    if (saved) return saved;
    const legacyToken = storedValue(`${TOKEN_PREFIX}${id}`);
    return legacyToken ? { id, version: -1, sessionToken: legacyToken } : undefined;
  }
  function rememberGame(view: GameView): boolean {
    const current = savedCheckpoint(view.id);
    if (current && current.version > view.version) throw new GameClientError(CLIENT_MESSAGES.stale, { status: 409, code: 'STALE_CHECKPOINT', requiresRefresh: true });
    if (!view.sessionToken) throw new GameClientError(CLIENT_MESSAGES.malformed, { code: 'BAD_RESPONSE' });
    const checkpoint = { id: view.id, version: view.version, sessionToken: view.sessionToken };
    memory.set(view.id, checkpoint);
    memorySession = view.id;
    try {
      const target = storage();
      if (!target) throw new Error('Storage unavailable');
      // One write commits the token and its version together. The pointer and
      // old token key are compatibility aids, never the authoritative pair.
      target.setItem(`${CHECKPOINT_PREFIX}${view.id}`, JSON.stringify(checkpoint));
      target.setItem(SESSION_KEY, view.id);
      storageFailed.delete(view.id);
      try { target.setItem(`${TOKEN_PREFIX}${view.id}`, view.sessionToken); } catch { /* The atomic checkpoint and resume pointer are already durable. */ }
      return true;
    } catch { storageFailed.add(view.id); return false; }
  }
  function forgetGame(id: string) {
    memory.delete(id); needsRefresh.delete(id); storageFailed.delete(id);
    if (memorySession === id) memorySession = '';
    try {
      const target = storage();
      target?.removeItem(`${CHECKPOINT_PREFIX}${id}`);
      target?.removeItem(`${TOKEN_PREFIX}${id}`);
      if (target?.getItem(SESSION_KEY) === id) target.removeItem(SESSION_KEY);
    } catch { /* Browser storage may be disabled. */ }
  }
  function checkpointNotice(id: string) { return storageFailed.has(id) ? CLIENT_MESSAGES.storage : undefined; }
  function validateGame(value: unknown, expectedId?: string): asserts value is GameView {
    const game = value as Partial<GameView> | null;
    const playerValid = (player: GameView['players']['human'] | undefined) => player && player.base && player.leader
      && ['hand', 'ground', 'space', 'resources', 'discard', 'leaders'].every(key => Array.isArray(player[key as keyof typeof player]));
    if (!game || typeof game !== 'object' || typeof game.id !== 'string' || !game.id
      || expectedId !== undefined && game.id !== expectedId
      || !Number.isSafeInteger(game.version) || (game.version as number) < 0
      || typeof game.sessionToken !== 'string' || !game.sessionToken.startsWith('swu1.')
      || !playerValid(game.players?.human) || !playerValid(game.players?.bot)
      || !game.prompt || !Array.isArray(game.prompt.buttons) || !Array.isArray(game.prompt.selectedCardIds)
      || !Array.isArray(game.prompt.selectableCardIds) || !Array.isArray(game.prompt.displayCards)
      || !Array.isArray(game.legalActions) || !Array.isArray(game.winnerIds) || !Array.isArray(game.log)
      || typeof game.phase !== 'string' || !Number.isFinite(game.round)) {
      throw new GameClientError(CLIENT_MESSAGES.malformed, { code: 'BAD_RESPONSE' });
    }
  }
  async function api<T>(path: string, body?: unknown, requestMethod?: string, requestOptions: RequestOptions = {}): Promise<T> {
    let method = requestMethod || (body === undefined ? 'GET' : 'POST');
    const match = path.match(/^\/api\/games\/([^/]+)(?:\/(actions|bot|state))?$/);
    const gameId = match ? decodeURIComponent(match[1]) : undefined;
    if (gameId) {
      if (method === 'GET') { if (!match?.[2]) path += '/state'; method = 'POST'; }
      body = { ...(body && typeof body === 'object' ? body : {}), sessionToken: savedCheckpoint(gameId)?.sessionToken || '' };
    }
    const controller = new AbortController();
    const timeoutMs = requestOptions.timeoutMs ?? options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation: (error: GameClientError) => void = () => {};
    const cancel = () => { controller.abort(); rejectCancellation(new GameClientError(CLIENT_MESSAGES.cancelled, { code: 'CANCELLED' })); };
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
      timer = setTimeout(() => {
        controller.abort(); reject(new GameClientError(CLIENT_MESSAGES.timeout, { code: 'TIMEOUT' }));
      }, Math.max(1, timeoutMs));
    });
    requestOptions.signal?.addEventListener('abort', cancel, { once: true });
    if (requestOptions.signal?.aborted) cancel();
    try {
      const data = await Promise.race([cancellation, (async () => {
        if (controller.signal.aborted) throw new GameClientError(CLIENT_MESSAGES.cancelled, { code: 'CANCELLED' });
        const response = await fetchRequest(path, {
          method, signal: controller.signal, headers: { 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status === 204 && method === 'DELETE') return undefined;
        let data: unknown;
        try { data = await response.json(); } catch {
          throw new GameClientError(response.ok ? CLIENT_MESSAGES.malformed : CLIENT_MESSAGES.unavailable, { status: response.status, code: response.ok ? 'BAD_RESPONSE' : 'REQUEST_FAILED' });
        }
        if (!response.ok) {
          const error = data as { error?: unknown; message?: unknown } | null;
          const message = typeof error?.error === 'string' ? error.error : typeof error?.message === 'string' ? error.message : CLIENT_MESSAGES.unavailable;
          throw new GameClientError(message, { status: response.status, details: data });
        }
        return data;
      })()]);
      if (method !== 'DELETE' && (gameId || path === '/api/games' && method === 'POST')) {
        validateGame(data, gameId);
        rememberGame(data);
      }
      return data as T;
    } catch (error) {
      if (error instanceof GameClientError) throw error;
      throw new GameClientError(CLIENT_MESSAGES.network, { code: 'NETWORK' });
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', cancel);
    }
  }
  async function withGameLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (pending.has(id)) throw new GameClientError(CLIENT_MESSAGES.busy, { status: 409, code: 'BUSY' });
    pending.add(id);
    try {
      const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
      if (!locks) return await operation();
      return await locks.request(`swu-command-game:${id}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new GameClientError(CLIENT_MESSAGES.busy, { status: 409, code: 'BUSY' });
        return operation();
      });
    } finally { pending.delete(id); }
  }
  async function recover(id: string, requestOptions: RequestOptions = {}): Promise<GameView> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const view = await api<GameView>(`/api/games/${encodeURIComponent(id)}`, undefined, 'GET', {
          ...requestOptions, timeoutMs: options.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS,
        });
        needsRefresh.delete(id);
        return view;
      } catch (error) {
        lastError = error;
        if (requestOptions.signal?.aborted || error instanceof GameClientError && (error.code === 'CANCELLED' || [400, 401, 403, 404, 410].includes(error.status || 0))) throw error;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, options.recoveryDelayMs ?? 350));
      }
    }
    throw lastError;
  }
  async function resumeGame(id: string, requestOptions: RequestOptions = {}): Promise<GameView> {
    return withGameLock(id, () => recover(id, requestOptions));
  }
  async function mutateGame(view: GameView, action: GameAction | 'bot', requestOptions: RequestOptions = {}): Promise<GameUpdate> {
    return withGameLock(view.id, async () => {
      const checkpoint = savedCheckpoint(view.id);
      if (needsRefresh.has(view.id) || checkpoint && checkpoint.version > view.version) {
        try { return { view: await recover(view.id, requestOptions), notice: CLIENT_MESSAGES.refresh }; }
        catch { throw new GameClientError(CLIENT_MESSAGES.unrecovered, { requiresRefresh: true, code: 'RECOVERY_FAILED' }); }
      }
      try {
        const updated = await api<GameView>(`/api/games/${encodeURIComponent(view.id)}/${action === 'bot' ? 'bot' : 'actions'}`,
          action === 'bot' ? {} : { ...action, version: view.version }, 'POST', requestOptions);
        return { view: updated, notice: checkpointNotice(view.id) };
      } catch (error) {
        const failure = error as GameClientError;
        // A lost response does not prove that a mutation failed. Never replay it.
        // Read back a saved checkpoint; a different worker may only have the
        // previous turn, so the recovery message deliberately makes no stronger claim.
        if (failure.status && failure.status < 500 && failure.status !== 409 && failure.code !== 'BAD_RESPONSE') throw failure;
        needsRefresh.add(view.id);
        if (requestOptions.signal?.aborted || failure.code === 'CANCELLED') {
          throw new GameClientError(CLIENT_MESSAGES.cancelled, { requiresRefresh: true, code: 'CANCELLED' });
        }
        try {
          const restored = await recover(view.id, requestOptions);
          return { view: restored, notice: failure.status === 409
            ? restored.version > view.version ? CLIENT_MESSAGES.stale : CLIENT_MESSAGES.refresh
            : CLIENT_MESSAGES.recovered };
        } catch {
          throw new GameClientError(CLIENT_MESSAGES.unrecovered, { requiresRefresh: true, code: 'RECOVERY_FAILED' });
        }
      }
    });
  }
  return { api, storedValue, rememberGame, forgetGame, checkpointNotice, resumeGame, mutateGame };
}

export const { api, storedValue, rememberGame, forgetGame, checkpointNotice, resumeGame, mutateGame } = createGameClient();
