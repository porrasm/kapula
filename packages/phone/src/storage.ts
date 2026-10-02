/**
 * localStorage with the one migration the rename needed: keys were
 * `gamepad:*` until protocol version 2 and are `kapula:*` since. A read of a
 * new key that finds nothing moves the old value over, so a phone pinned
 * under the old name keeps its session, its layouts and its orientation.
 * Every call swallows storage errors (private mode, quota): the caller
 * treats "nothing stored" and "storage unavailable" the same way.
 */
const LEGACY_PREFIX = "gamepad:";
export const STORAGE_PREFIX = "kapula:";

const legacyKey = (key: string): string | null =>
  key.startsWith(STORAGE_PREFIX) ? LEGACY_PREFIX + key.slice(STORAGE_PREFIX.length) : null;

export const storageGet = (key: string): string | null => {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
    const old = legacyKey(key);
    if (old === null) return null;
    const legacy = localStorage.getItem(old);
    if (legacy === null) return null;
    localStorage.setItem(key, legacy);
    localStorage.removeItem(old);
    return legacy;
  } catch {
    return null;
  }
};

export const storageSet = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — the value just does not survive */
  }
};

export const storageRemove = (key: string): void => {
  try {
    localStorage.removeItem(key);
    const old = legacyKey(key);
    if (old !== null) localStorage.removeItem(old);
  } catch {
    /* ignore */
  }
};
