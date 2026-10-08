import type { ImportedDeck, SavedCustomDeck } from './types';

export const CUSTOM_DECKS_KEY = 'swu-command-custom-decks';
const SCHEMA_VERSION = 1;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const entry = (value: unknown): boolean => object(value) && typeof value.id === 'string' && /^[A-Z0-9]{2,8}_\d{1,5}$/.test(value.id) && Number.isSafeInteger(value.count) && Number(value.count) > 0 && Number(value.count) <= 500;
const stringList = (value: unknown): boolean => value == null || (Array.isArray(value) && value.every(item => typeof item === 'string'));
const optionalStrings = (value: Record<string, unknown>, keys: string[]): boolean => keys.every(key => value[key] == null || typeof value[key] === 'string');
function visibleCard(value: unknown, depth = 0): boolean {
  if (!object(value) || depth > 4 || typeof value.name !== 'string' || (typeof value.id !== 'string' && typeof value.code !== 'string')) return false;
  if (!optionalStrings(value, ['uuid', 'id', 'code', 'subtitle', 'image', 'type', 'text', 'frontImage', 'backImage', 'frontText', 'deployText', 'epicAction', 'pilotText'])) return false;
  if (!stringList(value.aspects) || !stringList(value.traits)) return false;
  if (value.keywords != null && (!Array.isArray(value.keywords) || !value.keywords.every(keyword => typeof keyword === 'string' || object(keyword) && typeof keyword.name === 'string'))) return false;
  for (const key of ['upgrades', 'captured']) if (value[key] != null && (!Array.isArray(value[key]) || !value[key].every(card => visibleCard(card, depth + 1)))) return false;
  return ['cost', 'power', 'hp', 'damage', 'remainingHp', 'playCost', 'upgradePower', 'upgradeHp'].every(key => value[key] == null || typeof value[key] === 'number' && Number.isFinite(value[key]));
}
const cardRows = (value: unknown): boolean => Array.isArray(value) && value.length <= 500 && value.every(row => object(row) && Number.isSafeInteger(row.count) && Number(row.count) > 0 && Number(row.count) <= 500 && visibleCard(row.card));

/** Browser storage is a display cache, never authority for deck legality or card scripts. */
export function isImportedDeck(value: unknown): value is ImportedDeck {
  if (!object(value) || value.custom !== true || typeof value.id !== 'string' || !value.id.startsWith('custom-') || typeof value.name !== 'string' || value.name.length > 200) return false;
  if (!visibleCard(value.leader) || !visibleCard(value.base) || !cardRows(value.cards) || value.sideboardCards != null && !cardRows(value.sideboardCards)) return false;
  if (!optionalStrings(value, ['set', 'setName', 'description', 'product', 'format', 'playstyle']) || !stringList(value.aspects)) return false;
  if (value.coverage != null && (!object(value.coverage) || !stringList(value.coverage.missing))) return false;
  if (!object(value.validation) || value.validation.valid !== true || !Array.isArray(value.validation.errors) || !Array.isArray(value.validation.warnings)) return false;
  const recipe = value.recipe;
  return object(recipe) && recipe.custom === true && recipe.id === value.id && typeof recipe.name === 'string'
    && entry(recipe.leader) && entry(recipe.base) && Array.isArray(recipe.deck) && recipe.deck.length > 0 && recipe.deck.length <= 500 && recipe.deck.every(entry)
    && Array.isArray(recipe.sideboard) && recipe.sideboard.length <= 100 && recipe.sideboard.every(entry);
}

export function readCustomDecks(): SavedCustomDeck[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CUSTOM_DECKS_KEY) || 'null');
    if (!object(stored) || stored.version !== SCHEMA_VERSION || !Array.isArray(stored.decks)) return [];
    const unique = new Map<string, SavedCustomDeck>();
    for (const candidate of stored.decks) {
      if (!isImportedDeck(candidate)) continue;
      const raw = candidate as ImportedDeck & { savedAt?: number };
      unique.set(raw.id, { ...raw, savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt! : 0 });
    }
    return [...unique.values()];
  } catch { return []; }
}

export function persistCustomDecks(decks: SavedCustomDeck[]): void {
  try { localStorage.setItem(CUSTOM_DECKS_KEY, JSON.stringify({ version: SCHEMA_VERSION, decks })); }
  catch (error) {
    if (error && typeof error === 'object' && 'name' in error && /quota/i.test(String(error.name))) throw new Error('Your browser storage is full. Export or remove a saved deck, then try again.');
    throw new Error('Browser storage is unavailable. This deck has not been saved. You can export its JSON instead.');
  }
}

export function exportCustomDeck(deck: ImportedDeck): void {
  const data = JSON.stringify(deck.recipe, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(deck.name || 'custom-deck').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 100) || 'custom-deck'}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
