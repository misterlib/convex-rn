/**
 * Storage abstraction. Prefers MMKV when the native module is present;
 * falls back to in-memory so JS-only reloads on old binaries do not crash.
 */

export type Storage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

function createMemoryStorage(): Storage {
  const memoryStore = new Map<string, string>();
  return {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
    clear: () => {
      memoryStore.clear();
    },
  };
}

function tryCreateMmkvStorage(): Storage | null {
  try {
    // Lazy require: react-native-mmkv v4 loads Nitro at import time.
    const { createMMKV } = require('react-native-mmkv') as {
      createMMKV: (opts: { id: string }) => {
        getString: (key: string) => string | undefined;
        set: (key: string, value: string) => void;
        remove: (key: string) => void;
        clearAll: () => void;
      };
    };
    const storage = createMMKV({ id: 'convex-rn-sync-storage' });
    return {
      getItem: (key: string) => storage.getString(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.remove(key);
      },
      clear: () => {
        storage.clearAll();
      },
    };
  } catch (e) {
    console.warn(
      '[convex-rn] MMKV/Nitro not available; using in-memory cache. Rebuild the native app to persist offline data.',
      e
    );
    return null;
  }
}

export const syncStorage: Storage =
  tryCreateMmkvStorage() ?? createMemoryStorage();
