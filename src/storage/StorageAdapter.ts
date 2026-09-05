// A tiny key-value contract. App.tsx only talks to this interface, never to
// IndexedDB directly — so swapping in a cloud backend (Firebase, Supabase,
// a custom API, ...) later means writing one new adapter file, not touching
// the app logic.
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
