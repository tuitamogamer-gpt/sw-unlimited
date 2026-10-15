export type AccountStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys?: () => string[] };

/** Local saves are separated by the server-verified account, never an email.
 * Each client keeps its own immutable scope so a late response after sign-out
 * cannot write into the next player's collection. Guest keys remain compatible.
 */
export function createAccountStorage(ownerId: string | null, target?: AccountStorage): AccountStorage {
  if (ownerId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new Error('Invalid account storage scope.');
  const prefix = ownerId === null ? '' : `swu-command-account:${ownerId}:`;
  const storage = () => target ?? globalThis.localStorage;
  return {
    getItem: key => storage().getItem(prefix + key),
    setItem: (key, value) => storage().setItem(prefix + key, value),
    removeItem: key => storage().removeItem(prefix + key),
    keys: () => {
      const target = storage() as AccountStorage & Partial<Pick<Storage, 'key' | 'length'>>;
      const names = typeof target.keys === 'function' ? target.keys() : typeof target.key === 'function' && typeof target.length === 'number'
        ? Array.from({ length: target.length }, (_, index) => target.key!(index)).filter((key): key is string => key !== null) : [];
      return names.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    },
  };
}
