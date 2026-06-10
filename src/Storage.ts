import { type MMKV, createMMKV } from 'react-native-mmkv';

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

class MMKVStorage implements Storage {
  private mmkv: MMKV | null = null;
  private memoryCache = new Map<string, string>();

  constructor() {
    try {
      this.mmkv = createMMKV({
        id: 'convex-rn-sync-storage',
      });
    } catch (e) {
      console.warn(
        'Failed to initialize MMKV, falling back to memory store:',
        e
      );
    }
  }

  getItem(key: string): string | null {
    if (this.mmkv) {
      return this.mmkv.getString(key) ?? null;
    }
    return this.memoryCache.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.mmkv) {
      this.mmkv.set(key, value);
    } else {
      this.memoryCache.set(key, value);
    }
  }

  removeItem(key: string): void {
    if (this.mmkv) {
      this.mmkv.remove(key);
    } else {
      this.memoryCache.delete(key);
    }
  }

  clear(): void {
    if (this.mmkv) {
      this.mmkv.clearAll();
    } else {
      this.memoryCache.clear();
    }
  }
}

export const syncStorage: Storage = new MMKVStorage();
