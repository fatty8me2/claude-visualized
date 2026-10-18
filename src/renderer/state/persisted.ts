import { useSyncExternalStore } from 'react';

/**
 * A small localStorage-backed store shared by every component in this window. `sanitize` repairs whatever was stored (older
 * shapes, hand edits), so readers can trust the type. Storage failures (private mode, quota) leave the in-memory value working.
 */
export function createPersisted<T>(key: string, fallback: T, sanitize: (raw: unknown) => T) {
  let value: T | null = null;
  const subs = new Set<() => void>();
  const read = (): T => {
    if (value !== null) return value;
    try {
      const raw = localStorage.getItem(key);
      value = raw ? sanitize(JSON.parse(raw)) : fallback;
    } catch {
      value = fallback;
    }
    return value;
  };
  const write = (next: T | ((cur: T) => T)) => {
    value = typeof next === 'function' ? (next as (cur: T) => T)(read()) : next;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
    subs.forEach((f) => f());
  };
  const subscribe = (cb: () => void) => {
    subs.add(cb);
    return () => subs.delete(cb);
  };
  const use = (): [T, typeof write] => [useSyncExternalStore(subscribe, read), write];
  return { read, write, use };
}

export const strList = (v: unknown, cap: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-cap) : []);
