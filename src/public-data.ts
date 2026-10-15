import { api } from './game-client';
import type { Deck } from './types';
import type { TrainingLesson } from './components/Training';

export interface PublicDeckCatalog {
  decks: Deck[];
  sources?: { title?: string; name?: string; url: string; description?: string; kind?: string }[];
  rulesVersion?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const aspects = (value: unknown) => value === undefined || Array.isArray(value) && value.every(aspect => typeof aspect === 'string');

function decks(value: unknown): PublicDeckCatalog {
  const catalog = Array.isArray(value) ? { decks: value } : value;
  if (!object(catalog) || !Array.isArray(catalog.decks) || !catalog.decks.length
    || !catalog.decks.every(deck => object(deck) && text(deck.id) && text(deck.name) && object(deck.leader)
      && aspects(deck.aspects) && aspects(deck.leader.aspects) && (deck.base === undefined || object(deck.base) && aspects(deck.base.aspects)))
    || catalog.rulesVersion !== undefined && typeof catalog.rulesVersion !== 'string'
    || catalog.sources !== undefined && (!Array.isArray(catalog.sources) || !catalog.sources.every(source => object(source) && text(source.url)))) {
    throw new Error('The deck library could not be loaded. Try again.');
  }
  return catalog as unknown as PublicDeckCatalog;
}
function lessons(value: unknown): TrainingLesson[] {
  if (!object(value) || !Array.isArray(value.lessons) || !value.lessons.length
    || value.lessons.length > 32 || !value.lessons.every(lesson => object(lesson)
      && typeof lesson.id === 'string' && /^[a-z0-9-]{1,64}$/.test(lesson.id)
      && text(lesson.title) && text(lesson.summary) && text(lesson.duration))
    || new Set(value.lessons.map(lesson => lesson.id)).size !== value.lessons.length) {
    throw new Error('Training missions could not be loaded. Try again.');
  }
  return value.lessons as TrainingLesson[];
}

/** Share only public catalogs across player scopes; game and account requests
 * always use their own clients. Rejected loads are evicted so Retry can recover. */
export function createPublicDataClient({ request = (path: string) => api<unknown>(path), now = Date.now, ttlMs = 5 * 60_000 } = {}) {
  const cache = new Map<string, { promise: Promise<unknown>; expiresAt: number }>();
  function load<T>(path: '/api/decks' | '/api/training', validate: (value: unknown) => T): Promise<T> {
    const existing = cache.get(path);
    if (existing && existing.expiresAt > now()) return existing.promise as Promise<T>;
    const entry = { promise: null as unknown as Promise<T>, expiresAt: Infinity };
    entry.promise = Promise.resolve().then(() => request(path)).then(validate).then(value => {
      entry.expiresAt = now() + ttlMs;
      return value;
    }).catch(error => {
      if (cache.get(path) === entry) cache.delete(path);
      throw error;
    });
    cache.set(path, entry);
    return entry.promise;
  }
  return { loadDecks: () => load('/api/decks', decks), loadTraining: () => load('/api/training', lessons) };
}
export const publicData = createPublicDataClient();
