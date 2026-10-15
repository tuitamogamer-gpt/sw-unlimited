import { CUSTOM_DECKS_KEY, isImportedDeck, readCustomDecks } from '../custom-decks';
import type { AccountStorage } from './storage';
import type { GameView, ImportedDeck } from '../types';
import { createCloudJournal } from './cloud-journal';
import type { JournalIntent } from './cloud-journal';

export const CLOUD_PREFERENCES_KEY = 'swu-command-preferences';
export const CLOUD_MATCHES_KEY = 'swu-command-match-history';
export const CLOUD_TRAINING_KEY = 'swu-command-training-progress';
export const MATCH_HISTORY_KEY = CLOUD_MATCHES_KEY;
export const TRAINING_PROGRESS_KEY = CLOUD_TRAINING_KEY;
const SESSION_KEY = 'swu-command-session';
const CHECKPOINT_PREFIX = 'swu-command-checkpoint:';
const TOKEN_PREFIX = 'swu-command-state:';
const MAX_BATCH = 20;

export type CloudSaveKind = 'deck' | 'preferences' | 'currentGame' | 'match' | 'training';
export type CloudRecord = { version: number; value: unknown; updatedAt?: string | number; deleted?: boolean };
export type CloudItem = CloudRecord & { id: string };
export interface CloudSaveSnapshot {
  enabled: true;
  revision: number;
  decks: CloudItem[];
  preferences: CloudRecord;
  currentGame: CloudRecord;
  matches: CloudItem[];
  training: CloudRecord;
}
export type CloudConflict = {
  key: string; kind: CloudSaveKind; id?: string; localValue: unknown; cloudValue: unknown; canKeepLocal: boolean;
  localUpdatedAt?: number; cloudUpdatedAt?: number;
  localGameVersion?: number; cloudGameVersion?: number;
};
export type CloudSaveStatus = {
  state: 'loading' | 'synced' | 'pending' | 'offline' | 'conflict' | 'unavailable';
  pendingCount: number;
  conflicts: CloudConflict[];
  message?: string;
};
type Operation = { kind: CloudSaveKind; id?: string; expectedVersion: number; value: unknown };
type Pending = Operation & { key: string; conflicted?: boolean; checkpointVersion?: number; intents: JournalIntent[]; branches?: JournalIntent[] };
type Options = {
  ownerId: string;
  storage: AccountStorage;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  onStatus?: (status: CloudSaveStatus) => void;
  onChange?: () => void;
  debounceMs?: number;
  timeoutMs?: number;
};

export class CloudSaveError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly snapshot?: CloudSaveSnapshot) {
    super(message); this.name = 'CloudSaveError';
  }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const keyFor = (kind: CloudSaveKind, id?: string) => id ? `${kind}:${id}` : kind;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function validRecord(value: unknown): value is CloudRecord { return object(value) && version(value.version) && 'value' in value; }
function validSnapshot(value: unknown): value is CloudSaveSnapshot {
  return object(value) && value.enabled === true && version(value.revision)
    && ['decks', 'matches'].every(key => Array.isArray(value[key]) && (value[key] as unknown[]).length <= 2000
      && (value[key] as unknown[]).every(item => validRecord(item) && typeof (item as CloudItem).id === 'string'))
    && ['preferences', 'currentGame', 'training'].every(key => validRecord(value[key]));
}
function parse(value: string | null): unknown { try { return JSON.parse(value || 'null'); } catch { return null; } }
function preferenceValue(value: unknown): Record<string, unknown> | null {
  if (!object(value)) return null;
  const allowed = ['deckId', 'opponentDeckId', 'difficulty', 'compact', 'showLog', 'language', 'handView'];
  return Object.fromEntries(allowed.filter(key => key in value).map(key => [key, value[key]]));
}
function operationValue(kind: CloudSaveKind, value: unknown): unknown {
  if (kind === 'deck' && isImportedDeck(value)) return value.recipe;
  if (kind === 'preferences') return preferenceValue(value);
  if (kind === 'currentGame' && object(value)) return { gameId: value.gameId, sessionToken: value.sessionToken };
  return value;
}
function validGameView(value: unknown): value is GameView & { sessionToken: string } {
  if (!object(value) || typeof value.id !== 'string' || !version(value.version) || typeof value.sessionToken !== 'string'
    || !value.sessionToken.startsWith('swu1.') || !object(value.players) || !object(value.prompt)
    || !Array.isArray(value.legalActions) || !Array.isArray(value.winnerIds) || !Array.isArray(value.log)
    || typeof value.phase !== 'string' || !Number.isFinite(value.round)) return false;
  const player = (candidate: unknown) => object(candidate) && object(candidate.base) && object(candidate.leader)
    && ['hand', 'ground', 'space', 'resources', 'discard', 'leaders'].every(key => Array.isArray(candidate[key]));
  const prompt = value.prompt;
  return player(value.players.human) && player(value.players.bot)
    && ['buttons', 'selectedCardIds', 'selectableCardIds', 'displayCards'].every(key => Array.isArray(prompt[key]));
}

/** All durable keys belong to the immutable verified owner passed by the caller.
 * Local mutations remain synchronous. A journal survives network failures; CAS
 * conflicts keep both versions until the player explicitly chooses one.
 */
export function createCloudSaveClient(options: Options) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.ownerId)) throw new Error('Invalid cloud save owner.');
  const base = options.storage;
  const fetchRequest = options.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  let disposed = false;
  let loaded = false;
  let snapshot: CloudSaveSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushPromise: Promise<void> | null = null;
  let loadPromise: Promise<void> | null = null;
  let state: CloudSaveStatus['state'] = 'loading';
  let message: string | undefined;
  let persistenceWarning: string | undefined;
  const pending = new Map<string, Pending>();
  const controllers = new Set<AbortController>();
  const records = new Map<string, CloudRecord>();
  const checkpointVersions = new Map<string, number>();
  const blocked = new Set<string>();
  const journal = createCloudJournal({ ownerId: options.ownerId, storage: base, validateSnapshot: validSnapshot,
    onWarning: warning => { persistenceWarning = warning; } });

  function read(key: string): string | null { try { return base.getItem(key); } catch { return null; } }
  function assertActive() { if (disposed) throw new CloudSaveError('Cloud saving was cancelled.', 'CANCELLED'); }
  function installRecords(next: CloudSaveSnapshot) {
    if (snapshot && next.revision < snapshot.revision) return;
    snapshot = next; records.clear();
    next.decks.forEach(item => records.set(keyFor('deck', item.id), item));
    next.matches.forEach(item => records.set(keyFor('match', item.id), item));
    for (const kind of ['preferences', 'currentGame', 'training'] as const) records.set(kind, next[kind]);
  }
  const saved = journal.savedSnapshot();
  if (validSnapshot(saved)) installRecords(saved);
  function persist() {
    if (disposed) return;
    journal.saveSnapshot(snapshot);
  }
  function getStatus(): CloudSaveStatus {
    const conflicts = [...pending.values()].filter(item => item.conflicted).flatMap(item => (item.branches || [item]).map(branch => {
      const remote = records.get(item.key);
      const cloudVersion = object(remote?.value) ? remote.value.version : undefined;
      return {
        key: 'operationId' in branch ? `${item.key}::${branch.operationId}` : item.key,
        kind: item.kind, ...(item.id ? { id: item.id } : {}), localValue: branch.value,
        cloudValue: remote?.value ?? null, canKeepLocal: !olderCurrentTurn({ ...item, ...branch }),
        localUpdatedAt: 'createdAt' in branch ? branch.createdAt : item.intents[0]?.createdAt,
        cloudUpdatedAt: typeof remote?.updatedAt === 'number' ? remote.updatedAt : Date.parse(String(remote?.updatedAt || '')) || undefined,
        localGameVersion: item.kind === 'currentGame' && version(branch.checkpointVersion) ? branch.checkpointVersion : undefined,
        cloudGameVersion: item.kind === 'currentGame' && version(cloudVersion) ? cloudVersion : undefined,
      };
    }));
    const notice = persistenceWarning || message;
    return { state: conflicts.length ? 'conflict' : state, pendingCount: pending.size, conflicts, ...(notice ? { message: notice } : {}) };
  }
  function notify(next?: CloudSaveStatus['state'], notice?: string) {
    if (disposed) return;
    if (next) state = next;
    message = notice;
    options.onStatus?.(getStatus());
  }
  function schedule() {
    if (disposed || !loaded) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, options.debounceMs ?? 650);
  }
  function notifyQueued() {
    // A synchronous local save does not establish a working cloud connection.
    // Keep the last failure visible until a real retry starts.
    if (state === 'offline' || state === 'unavailable') notify(undefined, message);
    else notify(loaded ? 'pending' : state);
  }
  function enqueue(kind: CloudSaveKind, value: unknown, id?: string, checkpointVersion?: number) {
    if (disposed) return;
    reconcile();
    const key = keyFor(kind, id);
    const canonical = operationValue(kind, value);
    const existing = pending.get(key);
    if (kind === 'training' && existing?.intents.some(intent => same(intent.value, canonical))) return;
    if (existing && !existing.branches && same(existing.value, canonical)) return;
    // Never infer that a newer remote change is ours. An unresolved conflict
    // stays visible even when the player continues editing its local copy.
    if (!existing && same(operationValue(kind, records.get(key)?.value ?? null), canonical)) return;
    journal.write({ key, kind, ...(id ? { id } : {}), expectedVersion: existing?.expectedVersion ?? records.get(key)?.version ?? 0,
      value: canonical, ...(checkpointVersion !== undefined ? { checkpointVersion } : {}) }, kind === 'training' ? [] : existing?.intents || []);
    reconcile();
    persist(); notifyQueued(); schedule();
  }
  function currentCheckpoint(): { gameId: string; sessionToken: string; version?: number } | null {
    const id = read(SESSION_KEY);
    if (!id) return null;
    const checkpoint = parse(read(`${CHECKPOINT_PREFIX}${id}`));
    if (object(checkpoint) && checkpoint.id === id && version(checkpoint.version) && typeof checkpoint.sessionToken === 'string'
      && checkpoint.sessionToken.startsWith('swu1.')) return { gameId: id, sessionToken: checkpoint.sessionToken, version: checkpoint.version };
    const token = read(`${TOKEN_PREFIX}${id}`);
    return token?.startsWith('swu1.') ? { gameId: id, sessionToken: token } : null;
  }
  function queueCurrentGame() {
    const checkpoint = currentCheckpoint();
    if (!checkpoint) { if (!read(SESSION_KEY)) enqueue('currentGame', null); return; }
    const previousVersion = checkpointVersions.get(checkpoint.gameId);
    if (checkpoint.version !== undefined) {
      if (previousVersion !== undefined && previousVersion > checkpoint.version) return;
      checkpointVersions.set(checkpoint.gameId, checkpoint.version);
    }
    enqueue('currentGame', checkpoint, undefined, checkpoint.version);
  }
  function trackDecks(previous: ImportedDeck[], next: ImportedDeck[]) {
    const after = new Map(next.map(deck => [deck.id, deck]));
    for (const deck of previous) if (!after.has(deck.id)) enqueue('deck', null, deck.id);
    const before = new Map(previous.map(deck => [deck.id, deck]));
    for (const deck of next) if (!same(before.get(deck.id)?.recipe, deck.recipe)) enqueue('deck', deck.recipe, deck.id);
  }
  const storage: AccountStorage = {
    getItem: key => base.getItem(key),
    setItem(key, value) {
      const before = key === CUSTOM_DECKS_KEY ? readCustomDecks(base) : [];
      base.setItem(key, value);
      if (disposed) return;
      if (key === CUSTOM_DECKS_KEY) {
        const envelope = parse(value);
        if (object(envelope) && envelope.version === 1 && Array.isArray(envelope.decks)) trackDecks(before, readCustomDecks(base));
      } else if (key === CLOUD_PREFERENCES_KEY) {
        const preferences = parse(value);
        if (object(preferences)) enqueue('preferences', preferenceValue(preferences));
      } else if (key === SESSION_KEY) queueCurrentGame();
    },
    removeItem(key) {
      const before = key === CUSTOM_DECKS_KEY ? readCustomDecks(base) : [];
      base.removeItem(key);
      if (disposed) return;
      if (key === CUSTOM_DECKS_KEY) trackDecks(before, []);
      else if (key === CLOUD_PREFERENCES_KEY) enqueue('preferences', null);
      else if (key === SESSION_KEY) enqueue('currentGame', null);
    },
  };
  function writeCurrentGame(value: unknown) {
    const previous = read(SESSION_KEY);
    if (!object(value) || typeof value.gameId !== 'string' || typeof value.sessionToken !== 'string' || !value.sessionToken.startsWith('swu1.')) {
      if (previous) { base.removeItem(`${CHECKPOINT_PREFIX}${previous}`); base.removeItem(`${TOKEN_PREFIX}${previous}`); }
      base.removeItem(SESSION_KEY); return;
    }
    const checkpoint = parse(read(`${CHECKPOINT_PREFIX}${value.gameId}`));
    if (version(value.version)) {
      base.setItem(`${CHECKPOINT_PREFIX}${value.gameId}`, JSON.stringify({ id: value.gameId, version: value.version, sessionToken: value.sessionToken }));
      checkpointVersions.set(value.gameId, value.version);
    } else if (!object(checkpoint) || checkpoint.sessionToken !== value.sessionToken) {
      // Older cloud snapshots expose actionCount, which is not a board version.
      // The compatible opaque token can still be restored by the native engine.
      base.removeItem(`${CHECKPOINT_PREFIX}${value.gameId}`);
    }
    base.setItem(`${TOKEN_PREFIX}${value.gameId}`, value.sessionToken);
    base.setItem(SESSION_KEY, value.gameId);
  }
  function hydrate() {
    if (!snapshot || disposed) return;
    const cacheKeys = [CUSTOM_DECKS_KEY, CLOUD_PREFERENCES_KEY, CLOUD_MATCHES_KEY, CLOUD_TRAINING_KEY, SESSION_KEY];
    const before = cacheKeys.map(read);
    try {
      const localDecks = new Map(readCustomDecks(base).map(deck => [deck.id, deck]));
      for (const item of snapshot.decks) {
        if (pending.has(keyFor('deck', item.id))) continue;
        if (item.deleted || item.value === null) localDecks.delete(item.id);
        else if (isImportedDeck(item.value)) localDecks.set(item.id, { ...item.value,
          savedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(String(item.updatedAt || '')) || 0 });
      }
      base.setItem(CUSTOM_DECKS_KEY, JSON.stringify({ version: 1, decks: [...localDecks.values()] }));
      if (!pending.has('preferences')) {
        if (snapshot.preferences.value !== null) base.setItem(CLOUD_PREFERENCES_KEY, JSON.stringify(snapshot.preferences.value));
        else if (snapshot.preferences.version > 0) base.removeItem(CLOUD_PREFERENCES_KEY);
      }
      if (!pending.has('currentGame') && (snapshot.currentGame.version > 0 || snapshot.currentGame.value !== null)) writeCurrentGame(snapshot.currentGame.value);
      const matches = new Map(snapshot.matches.filter(item => !item.deleted && item.value !== null).map(item => [item.id, item.value]));
      const localMatches = parse(read(CLOUD_MATCHES_KEY));
      for (const item of pending.values()) {
        if (item.kind !== 'match' || !item.id) continue;
        if (item.value === null) matches.delete(item.id);
        else if (Array.isArray(localMatches)) {
          const local = localMatches.find(value => object(value) && value.gameId === item.id);
          if (local) matches.set(item.id, local);
        }
      }
      base.setItem(CLOUD_MATCHES_KEY, JSON.stringify([...matches.values()]));
      if (snapshot.training.value !== null) {
        let progress = snapshot.training.value;
        const localProgress = parse(read(CLOUD_TRAINING_KEY));
        if (pending.has('training') && object(progress) && Array.isArray(progress.completedLessonIds)
          && object(localProgress) && Array.isArray(localProgress.completedLessonIds)) {
          progress = { completedLessonIds: [...new Set([...progress.completedLessonIds, ...localProgress.completedLessonIds].filter(id => typeof id === 'string'))] };
        }
        base.setItem(CLOUD_TRAINING_KEY, JSON.stringify(progress));
      }
    } catch { message = 'Cloud saves loaded, but browser storage is unavailable. Keep this tab open.'; }
    if (cacheKeys.some((key, index) => before[index] !== read(key))) options.onChange?.();
  }
  function migrateLocal() {
    for (const deck of readCustomDecks(base)) if (!records.has(keyFor('deck', deck.id)) && !pending.has(keyFor('deck', deck.id))) enqueue('deck', deck.recipe, deck.id);
    const preferences = parse(read(CLOUD_PREFERENCES_KEY));
    if (!records.get('preferences')?.version && object(preferences) && !pending.has('preferences')) enqueue('preferences', preferences);
    if (!pending.has('currentGame')) {
      const checkpoint = currentCheckpoint();
      const remote = records.get('currentGame');
      // A checkpoint/pointer write can survive while its larger journal write
      // fails. Never replace a demonstrably newer turn with an older cloud turn.
      const newerLocal = checkpoint && object(remote?.value) && checkpoint.gameId === remote.value.gameId
        && version(checkpoint.version) && version(remote.value.version) && checkpoint.version > remote.value.version;
      if (checkpoint && (!remote?.version || newerLocal)) enqueue('currentGame', checkpoint, undefined, checkpoint.version);
    }
  }
  async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    assertActive();
    const controller = new AbortController(); controllers.add(controller);
    const assertRequestActive = () => {
      assertActive();
      if (controller.signal.aborted) throw new CloudSaveError('Cloud saving is offline. Your changes are kept on this device.', 'OFFLINE');
    };
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new CloudSaveError(disposed ? 'Cloud saving was cancelled.'
        : 'Cloud saving is offline. Your changes are kept on this device.', disposed ? 'CANCELLED' : 'OFFLINE')), { once: true });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new CloudSaveError('Cloud saving is offline. Your changes are kept on this device.', 'OFFLINE')); }, options.timeoutMs ?? 12_000);
    });
    try {
      return await Promise.race([deadline, cancelled, (async () => {
        const token = await options.getAccessToken(); assertRequestActive();
        if (options.ownerId.startsWith('supabase_')) {
          // A token lookup may finish after another tab switches accounts. This
          // comparison only rejects mismatches; the server still verifies JWTs.
          let tokenOwner = '';
          try {
            const claims = JSON.parse(atob((token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            if (typeof claims.sub === 'string') tokenOwner = `supabase_${claims.sub.toLowerCase()}`;
          } catch { /* Expired/missing tokens cannot fall through to another cookie account. */ }
          if (tokenOwner !== options.ownerId) throw new CloudSaveError('Sign in again to resume cloud saving. Your changes are kept on this device.', 'AUTH', 401);
        }
        const response = await fetchRequest(path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'X-SWU-Owner': options.ownerId, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-SWU-CSRF': '1' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        assertRequestActive();
        const data: unknown = await response.json(); assertRequestActive();
        if (!response.ok) {
          if (response.status === 409 && object(data) && validSnapshot(data.snapshot)) throw new CloudSaveError('This save changed on another device. Choose which version to keep.', 'CONFLICT', 409, data.snapshot);
          if ([401, 403].includes(response.status)) throw new CloudSaveError('Sign in again to resume cloud saving. Your changes are kept on this device.', 'AUTH', response.status);
          if ([404, 503].includes(response.status)) throw new CloudSaveError('Cloud saving is not available yet. Your changes are kept on this device.', 'UNAVAILABLE', response.status);
          throw new CloudSaveError('Cloud saving could not be completed. Your changes are kept on this device.', 'FAILED', response.status);
        }
        return data;
      })()]);
    } catch (error) {
      if (disposed) throw new CloudSaveError('Cloud saving was cancelled.', 'CANCELLED');
      if (error instanceof CloudSaveError) throw error;
      throw new CloudSaveError('Cloud saving is offline. Your changes are kept on this device.', 'OFFLINE');
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  function accept(next: CloudSaveSnapshot) {
    installRecords(next); persist(); hydrate();
  }
  function olderCurrentTurn(item: Pending): boolean {
    const remote = records.get(item.key)?.value;
    return item.kind === 'currentGame' && object(item.value) && object(remote) && item.value.gameId === remote.gameId
      && version(item.checkpointVersion) && version(remote.version) && item.checkpointVersion < remote.version;
  }
  function reconcile() {
    const groups = new Map<string, JournalIntent[]>();
    for (const intent of journal.readIntents()) groups.set(intent.key, [...(groups.get(intent.key) || []), intent]);
    pending.clear();
    for (const [key, intents] of groups) {
      const selected = intents[0];
      let branches: JournalIntent[] | undefined;
      if (selected.kind !== 'training' && intents.length > 1) {
        const equivalent = intents.every(intent => same(intent.value, selected.value));
        // Counts do not establish lineage between opaque signed checkpoints.
        // Only explicit causal supersession or identical values can coalesce.
        if (!equivalent) branches = intents;
      }
      const item: Pending = { key, kind: selected.kind, ...(selected.id ? { id: selected.id } : {}), expectedVersion: selected.expectedVersion,
        value: selected.value, intents, ...(selected.checkpointVersion !== undefined ? { checkpointVersion: selected.checkpointVersion } : {}),
        ...(branches ? { branches, conflicted: true } : {}) };
      pending.set(key, item);
      const remote = records.get(item.key);
      const remoteVersion = remote?.version ?? 0;
      if (intents.some(intent => blocked.has(intent.operationId))) item.conflicted = true;
      if (branches) continue;
      if (olderCurrentTurn(item)) { item.conflicted = true; continue; }
      if (remoteVersion === item.expectedVersion) continue;
      if (same(operationValue(item.kind, remote?.value ?? null), item.value)) { journal.acknowledge(intents); pending.delete(item.key); continue; }
      // Native lesson proofs can only add verified completions; rebasing does
      // not overwrite progress from another device.
      if (item.kind === 'training') item.expectedVersion = remoteVersion;
      else item.conflicted = true;
    }
  }
  function failure(error: unknown) {
    if (disposed) return;
    notify(error instanceof CloudSaveError && ['UNAVAILABLE', 'AUTH'].includes(error.code) ? 'unavailable' : 'offline',
      error instanceof Error ? error.message : 'Cloud saving is offline. Your changes are kept on this device.');
    persist();
  }
  function load(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      notify('loading');
      try {
        const data = await request('/api/account/saves');
        if (!validSnapshot(data)) throw new CloudSaveError('Cloud saves could not be read. Local saves have been kept.', 'BAD_RESPONSE');
        installRecords(data); reconcile(); loaded = true;
        // Migrate before hydration so remote tombstones are authoritative and
        // old local-only collections are not uploaded as a whole replacement.
        migrateLocal(); accept(data);
        notify(pending.size ? 'pending' : 'synced'); schedule();
      } catch (error) { failure(error); }
      finally { loadPromise = null; }
    })();
    return loadPromise;
  }
  function flush(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (flushPromise) return flushPromise;
    clearTimeout(timer);
    flushPromise = (async () => {
      if (!loaded) await load();
      if (!loaded || disposed) return;
      for (let attempt = 0; attempt < 4 && !disposed; attempt++) {
        reconcile();
        const batch = [...pending.values()].filter(item => !item.conflicted).slice(0, MAX_BATCH).map(item => ({ ...item }));
        if (!batch.length) { notify(pending.size ? 'pending' : 'synced'); return; }
        notify('pending');
        try {
          const operations: Operation[] = batch.map(({ kind, id, expectedVersion, value }) => ({ kind, ...(id ? { id } : {}), expectedVersion, value }));
          const data = await request('/api/account/saves', 'PATCH', { operations });
          if (!validSnapshot(data)) throw new CloudSaveError('Cloud saves could not be confirmed. Local changes have been kept.', 'BAD_RESPONSE');
          installRecords(data);
          const remaining = journal.readIntents();
          for (const sent of batch) {
            const confirmed = sent.kind === 'training' ? sent.intents.filter(intent => same(intent.value, sent.value)) : sent.intents;
            journal.acknowledge(confirmed);
            if (sent.kind === 'training') continue;
            const ids = new Set(confirmed.map(intent => intent.operationId));
            for (const newer of remaining) {
              if (newer.key !== sent.key || ids.has(newer.operationId) || !newer.supersedes.some(id => ids.has(id))) continue;
              journal.write({ key: newer.key, kind: newer.kind, ...(newer.id ? { id: newer.id } : {}), value: newer.value,
                expectedVersion: records.get(sent.key)?.version ?? sent.expectedVersion,
                ...(newer.checkpointVersion !== undefined ? { checkpointVersion: newer.checkpointVersion } : {}) }, [newer]);
            }
          }
          reconcile(); accept(data);
        } catch (error) {
          if (error instanceof CloudSaveError && error.code === 'CONFLICT' && error.snapshot) {
            installRecords(error.snapshot); reconcile(); accept(error.snapshot);
            if (batch.every(item => records.get(item.key)?.version === item.expectedVersion)
              && !batch.some(item => pending.get(item.key)?.conflicted)) {
              // A same-version rejection may be a native monotonic-turn guard.
              // Keep the failed batch reviewable instead of retrying forever.
              for (const item of batch) for (const intent of item.intents) blocked.add(intent.operationId);
              reconcile();
              persist();
            }
            continue;
          }
          failure(error); return;
        }
      }
      notify(pending.size ? 'pending' : 'synced');
      if ([...pending.values()].some(item => !item.conflicted)) schedule();
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  }
  async function retry() { await load(); await flush(); }
  async function resolveConflict(key: string, choice: 'local' | 'cloud') {
    assertActive();
    reconcile();
    const separator = key.lastIndexOf('::');
    const logicalKey = separator === -1 ? key : key.slice(0, separator);
    const branchId = separator === -1 ? undefined : key.slice(separator + 2);
    const item = pending.get(logicalKey);
    if (!item?.conflicted) return;
    const branch = branchId ? item.intents.find(intent => intent.operationId === branchId) : undefined;
    if (branchId && !branch) return;
    if (choice === 'local') {
      const selected = branch ? { ...item, ...branch } : item;
      if (olderCurrentTurn(selected)) throw new CloudSaveError('Your account has a newer turn of this game. Use the account version to continue.', 'OLDER_TURN');
      journal.write({ key: logicalKey, kind: selected.kind, ...(selected.id ? { id: selected.id } : {}), value: selected.value,
        expectedVersion: records.get(logicalKey)?.version ?? 0,
        ...(selected.checkpointVersion !== undefined ? { checkpointVersion: selected.checkpointVersion } : {}) }, item.intents);
    }
    else journal.acknowledge(item.intents);
    reconcile();
    if (choice === 'cloud') hydrate();
    persist(); notify(pending.size ? 'pending' : 'synced');
    if (choice === 'local') await flush();
  }
  async function restoreCurrentGame(): Promise<GameView> {
    assertActive();
    if (pending.has('currentGame')) throw new CloudSaveError('Save or resolve this device’s current game before restoring the cloud game.', 'PENDING_GAME');
    const data = await request('/api/account/saves/current-game/restore', 'POST', {});
    const expected = snapshot?.currentGame.value;
    if (!validGameView(data) || object(expected) && data.id !== expected.gameId) {
      throw new CloudSaveError('The cloud game could not be restored. Your saved game has been kept.', 'BAD_RESPONSE');
    }
    assertActive();
    base.setItem(`${CHECKPOINT_PREFIX}${data.id}`, JSON.stringify({ id: data.id, version: data.version, sessionToken: data.sessionToken }));
    base.setItem(SESSION_KEY, data.id);
    base.setItem(`${TOKEN_PREFIX}${data.id}`, data.sessionToken);
    checkpointVersions.set(data.id, data.version);
    enqueue('currentGame', { gameId: data.id, sessionToken: data.sessionToken }, undefined, data.version);
    options.onChange?.();
    return data;
  }
  function saveMatch(game: { gameId: string; sessionToken?: string } | Pick<GameView, 'id' | 'sessionToken'>) {
    if (!game.sessionToken) return;
    const gameId = 'gameId' in game ? game.gameId : game.id;
    enqueue('match', { gameId, sessionToken: game.sessionToken }, gameId);
  }
  function saveTraining(game: { gameId: string; sessionToken?: string } | Pick<GameView, 'id' | 'sessionToken'>) {
    if (!game.sessionToken) return;
    enqueue('training', { gameId: 'gameId' in game ? game.gameId : game.id, sessionToken: game.sessionToken });
  }
  function removeMatch(id: string) { enqueue('match', null, id); }
  function dispose() {
    if (disposed) return;
    persist(); disposed = true; clearTimeout(timer);
    controllers.forEach(controller => controller.abort()); controllers.clear();
  }
  return { storage, load, flush, retry, dispose, getStatus, getSnapshot: () => snapshot, resolveConflict, restoreCurrentGame, saveMatch, removeMatch, saveTraining };
}

export type CloudSaveClient = ReturnType<typeof createCloudSaveClient>;
