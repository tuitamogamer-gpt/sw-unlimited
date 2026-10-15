import type { AccountStorage } from './storage';

export const CLOUD_JOURNAL_KEY = 'swu-command-cloud-sync:v1';
export const CLOUD_JOURNAL_CACHE_KEY = 'swu-command-cloud-cache:v2';
export const CLOUD_OPERATION_PREFIX = 'swu-command-cloud-operation:v1:';
const ACK_PREFIX = 'swu-command-cloud-ack:v1:';
const WARNING = 'Cloud saving is queued in this tab. Keep it open until the connection returns.';
export type JournalKind = 'deck' | 'preferences' | 'currentGame' | 'match' | 'training';
export type JournalIntent = {
  operationId: string; ownerId: string; key: string; kind: JournalKind; id?: string;
  expectedVersion: number; value: unknown; checkpointVersion?: number; supersedes: string[]; createdAt: number;
};
type IntentInput = Omit<JournalIntent, 'operationId' | 'ownerId' | 'supersedes' | 'createdAt'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const kinds: JournalKind[] = ['deck', 'preferences', 'currentGame', 'match', 'training'];
const parse = (value: string | null): unknown => { try { return JSON.parse(value || 'null'); } catch { return null; } };
const operationKey = (kind: JournalKind, id?: string) => id ? `${kind}:${id}` : kind;
function validIntent(value: unknown, ownerId: string): value is JournalIntent {
  if (!object(value) || value.ownerId !== ownerId || typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.operationId)
    || !kinds.includes(value.kind as JournalKind) || !version(value.expectedVersion) || !('value' in value)
    || !Array.isArray(value.supersedes) || value.supersedes.some(id => typeof id !== 'string') || !Number.isFinite(value.createdAt)) return false;
  const kind = value.kind as JournalKind;
  return ((kind === 'deck' || kind === 'match') ? typeof value.id === 'string' : value.id === undefined)
    && value.key === operationKey(kind, value.id as string | undefined);
}
function legacyId(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const character of JSON.stringify(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(character.charCodeAt(0))) * 1099511628211n);
  return `legacy_${hash.toString(16)}`;
}

/** Each intent has an immutable key. Acknowledging an exact ID can never erase
 * another tab's newer intent, even when both tabs write between enumeration and
 * acknowledgement. The shared snapshot below is only an advisory cache.
 */
export function createCloudJournal({ ownerId, storage, onWarning, validateSnapshot }: {
  ownerId: string; storage: AccountStorage; onWarning: (warning: string | undefined) => void;
  validateSnapshot?: (snapshot: unknown) => boolean;
}) {
  const known = new Set<string>();
  const memoryOnly = new Map<string, JournalIntent>();
  const cached = new Map<string, JournalIntent>();
  const acknowledged = new Set<string>();
  let warning: string | undefined;
  let migrating = false;
  let readsFailed = false;
  function readResult(key: string) {
    try { return { value: storage.getItem(key), failed: false }; }
    catch { readsFailed = true; fail(); return { value: null, failed: true }; }
  }
  function read(key: string) { return readResult(key).value; }
  function fail() { warning = WARNING; onWarning(warning); }
  function caches() {
    return [CLOUD_JOURNAL_CACHE_KEY, CLOUD_JOURNAL_KEY].flatMap(key => {
      const value = parse(read(key));
      return object(value) && value.ownerId === ownerId && (value.schema === 1 || value.schema === 2) ? [value] : [];
    });
  }
  function snapshotObject(value: unknown): value is Record<string, unknown> & { revision: number } {
    return object(value) && version(value.revision) && (!validateSnapshot || validateSnapshot(value));
  }
  function cache() {
    const available = caches();
    const valid = available.filter(value => snapshotObject(value.snapshot));
    return valid.reduce<Record<string, unknown> | null>((best, value) => !best
      || (value.snapshot as { revision: number }).revision > (best.snapshot as { revision: number }).revision ? value : best, null)
      || available[0] || null;
  }
  function writeIntent(intent: JournalIntent): boolean {
    known.add(intent.operationId);
    cached.set(intent.operationId, intent);
    try {
      storage.setItem(CLOUD_OPERATION_PREFIX + intent.operationId, JSON.stringify(intent));
      memoryOnly.delete(intent.operationId); return true;
    } catch { memoryOnly.set(intent.operationId, intent); fail(); return false; }
  }
  function removeExact(id: string) {
    const key = CLOUD_OPERATION_PREFIX + id;
    const value = parse(read(key));
    if (validIntent(value, ownerId) && value.operationId === id) {
      try { storage.removeItem(key); } catch { /* Its immutable acknowledgement remains authoritative. */ }
    }
  }
  function acknowledgedOnDisk(id: string) {
    const value = parse(read(ACK_PREFIX + id));
    return object(value) && value.ownerId === ownerId && value.operationId === id;
  }
  function migrate() {
    if (migrating) return;
    // The v1 key is a read-only migration source. A live v1 tab may still
    // append to it while this client writes its separate advisory cache.
    const source = parse(read(CLOUD_JOURNAL_KEY));
    const previous = object(source) && source.ownerId === ownerId && source.schema === 1 ? source : null;
    if (previous?.schema !== 1 || !Array.isArray(previous.pending)) return;
    migrating = true;
    for (const raw of previous.pending) {
      if (!object(raw) || !kinds.includes(raw.kind as JournalKind) || !version(raw.expectedVersion) || !('value' in raw)) continue;
      const kind = raw.kind as JournalKind, id = typeof raw.id === 'string' ? raw.id : undefined;
      if (raw.key !== operationKey(kind, id) || ((kind === 'deck' || kind === 'match') !== !!id)) continue;
      const values = kind === 'training' && Array.isArray(raw.trainingQueue) ? [raw.value, ...raw.trainingQueue] : [raw.value];
      for (let index = 0; index < values.length; index++) {
        const operationId = legacyId({ ownerId, raw, index });
        if (acknowledgedOnDisk(operationId)) continue;
        const existing = parse(read(CLOUD_OPERATION_PREFIX + operationId));
        if (validIntent(existing, ownerId)) { known.add(operationId); continue; }
        const intent: JournalIntent = { operationId, ownerId, key: raw.key as string, kind, ...(id ? { id } : {}),
          expectedVersion: raw.expectedVersion, value: values[index], supersedes: [], createdAt: 0,
          ...(version(raw.checkpointVersion) ? { checkpointVersion: raw.checkpointVersion } : {}) };
        writeIntent(intent);
      }
    }
    migrating = false;
  }
  function readIntents(): JournalIntent[] {
    readsFailed = false;
    migrate();
    for (const previous of caches()) if (Array.isArray(previous.operationIds)) {
      for (const id of previous.operationIds) if (typeof id === 'string') known.add(id);
    }
    let names: string[] = [];
    try { names = storage.keys?.() || []; } catch { readsFailed = true; fail(); }
    for (const name of names) if (name.startsWith(CLOUD_OPERATION_PREFIX)) known.add(name.slice(CLOUD_OPERATION_PREFIX.length));
    const active = new Map<string, JournalIntent>();
    for (const id of known) {
      if (acknowledged.has(id) || acknowledgedOnDisk(id)) {
        removeExact(id); known.delete(id); cached.delete(id); memoryOnly.delete(id); continue;
      }
      // Verify the exact key. Missing an array entry during another tab's
      // enumeration must not acknowledge that tab's operation.
      const result = readResult(CLOUD_OPERATION_PREFIX + id);
      const raw = parse(result.value);
      if (validIntent(raw, ownerId) && raw.operationId === id) { active.set(id, raw); cached.set(id, raw); }
      else if (result.failed && cached.has(id)) active.set(id, cached.get(id)!);
      else if (!result.failed && result.value === null) { known.delete(id); cached.delete(id); }
    }
    for (const intent of memoryOnly.values()) {
      if (acknowledged.has(intent.operationId) || acknowledgedOnDisk(intent.operationId)) { memoryOnly.delete(intent.operationId); continue; }
      active.set(intent.operationId, intent);
    }
    const superseded = new Set([...active.values()].flatMap(intent => intent.supersedes));
    return [...active.values()].filter(intent => !superseded.has(intent.operationId));
  }
  function write(input: IntentInput, observed: JournalIntent[] = []): JournalIntent {
    const operationId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    const supersedes = [...new Set(observed.flatMap(intent => [intent.operationId, ...intent.supersedes]))];
    const intent: JournalIntent = { ...input, ownerId, operationId, supersedes, createdAt: Date.now() };
    if (writeIntent(intent)) {
      // The replacement is durable before causal predecessors are removed.
      for (const id of supersedes) { memoryOnly.delete(id); removeExact(id); known.delete(id); cached.delete(id); }
    }
    return intent;
  }
  function acknowledge(intents: JournalIntent[]) {
    const ids = [...new Set(intents.flatMap(intent => [intent.operationId, ...intent.supersedes]))];
    for (const id of ids) {
      acknowledged.add(id); memoryOnly.delete(id);
      try {
        storage.setItem(ACK_PREFIX + id, JSON.stringify({ operationId: id, ownerId, acknowledgedAt: Date.now() }));
        removeExact(id); known.delete(id); cached.delete(id);
      } catch { fail(); }
    }
  }
  function saveSnapshot(snapshot: unknown) {
    migrate();
    const previous = cache();
    const oldSnapshot = snapshotObject(previous?.snapshot) ? previous.snapshot : null;
    const selected = oldSnapshot && (!snapshotObject(snapshot) || oldSnapshot.revision > snapshot.revision) ? oldSnapshot : snapshot;
    try {
      storage.setItem(CLOUD_JOURNAL_CACHE_KEY, JSON.stringify({ schema: 2, ownerId, snapshot: selected, operationIds: [...known].filter(id => !acknowledged.has(id)) }));
      if (!memoryOnly.size && !readsFailed) { warning = undefined; onWarning(undefined); }
    } catch { fail(); }
    // Normal operation IDs are never republished. Keep short-lived receipts
    // for in-flight readers; legacy receipts must outlive old journal copies.
    let keys: string[] = [];
    try { keys = storage.keys?.() || []; } catch { return; }
    for (const key of keys) {
      if (!key.startsWith(ACK_PREFIX) || key.startsWith(`${ACK_PREFIX}legacy_`)) continue;
      const receipt = parse(read(key));
      if (object(receipt) && receipt.ownerId === ownerId && typeof receipt.operationId === 'string'
        && typeof receipt.acknowledgedAt === 'number' && receipt.acknowledgedAt < Date.now() - 60_000) {
        const original = readResult(CLOUD_OPERATION_PREFIX + receipt.operationId);
        if (!original.failed && original.value === null) {
          try { storage.removeItem(key); } catch { /* Receipts can be collected on the next successful save. */ }
        }
      }
    }
  }
  return { readIntents, write, acknowledge, saveSnapshot, savedSnapshot: () => cache()?.snapshot ?? null, getWarning: () => warning };
}
