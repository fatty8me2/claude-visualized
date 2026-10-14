import { useEffect, useState } from 'react';
import type { AppConfigView, HookServerStatusView } from '@core/api';
import type { SessionSummary, SessionView } from '@core/state';

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useSessions(): SessionSummary[] {
  const [s, set] = useState<SessionSummary[]>([]);
  useEffect(() => {
    void window.api.getSessions().then(set);
    return window.api.onSessions((v) => set([...v]));
  }, []);
  return s;
}

export function useLiveState(): SessionView | null {
  const [s, set] = useState<SessionView | null>(null);
  useEffect(() => {
    void window.api.getState().then(set);
    return window.api.onState(set);
  }, []);
  return s;
}

export function useSelected(): string | null {
  const [s, set] = useState<string | null>(null);
  useEffect(() => {
    void window.api.getSelected().then(set);
    return window.api.onSelected(set);
  }, []);
  return s;
}

export function useConfig(): AppConfigView | null {
  const [c, set] = useState<AppConfigView | null>(null);
  useEffect(() => {
    void window.api.getConfig().then(set);
    return window.api.onConfig(set);
  }, []);
  return c;
}

export function useHookServer(): HookServerStatusView | null {
  const [s, set] = useState<HookServerStatusView | null>(null);
  useEffect(() => {
    void window.api.hookServerStatus().then(set);
    return window.api.onHookServerStatus((v) => set({ ...v }));
  }, []);
  return s;
}
