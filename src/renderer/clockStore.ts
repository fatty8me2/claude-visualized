import { useSyncExternalStore } from 'react';

/**
 * A tiny clock store so that a per-second tick does not re-render a whole graph of cards.
 * The owner (AgentGraph) sets the time (wall clock, or the replay clock) and notifies; each card subscribes
 * with a key function and re-renders only when ITS displayed text changed (elapsed seconds, status, sparkline...).
 */
export interface Clock {
  get(): number;
  set(now: number): void;
  notify(): void;
  subscribe(cb: () => void): () => void;
}

export function createClock(initial: number): Clock {
  let now = initial;
  const subs = new Set<() => void>();
  return {
    get: () => now,
    set: (n) => {
      now = n;
    },
    notify: () => subs.forEach((cb) => cb()),
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** Re-render when `key(now)` changes. Returns the current time to render with. */
export function useClockKey(clock: Clock, key: (now: number) => string): number {
  useSyncExternalStore(clock.subscribe, () => key(clock.get()));
  return clock.get();
}
