import { useEffect, useState } from 'react';
import type { AppConfigView, HookServerStatusView } from '@core/api';
import type { SessionSummary, SessionView } from '@core/state';
import { OverviewDecoder, ViewDecoder } from '@core/sync';
import type { UsageView } from '@core/usage';

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
    // pushes are deltas: rebuild the view locally; fetch a snapshot first, and again whenever a push does not fit
    const dec = new ViewDecoder();
    let fetching = false;
    let alive = true;
    const resync = () => {
      if (fetching) return;
      fetching = true;
      void window.api.getState().then((v) => {
        fetching = false;
        if (!alive) return;
        dec.adopt(v);
        set(v);
      });
    };
    const off = window.api.onState((m) => {
      if (fetching) return;
      const v = dec.apply(m);
      if (v === undefined) resync();
      else set(v);
    });
    resync();
    return () => {
      alive = false;
      off();
    };
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

/** Live snapshots of every live session, while the calling component is mounted. */
export function useOverview(): SessionView[] | null {
  const [v, set] = useState<SessionView[] | null>(null);
  useEffect(() => {
    const dec = new OverviewDecoder();
    let fetching = false;
    let alive = true;
    const resync = () => {
      if (fetching) return;
      fetching = true;
      void window.api.getOverview().then((vs) => {
        fetching = false;
        if (!alive) return;
        dec.adopt(vs);
        set(vs);
      });
    };
    resync();
    void window.api.watchOverview(true);
    const off = window.api.onOverview((m) => {
      if (fetching) return;
      const vs = dec.apply(m);
      if (vs === undefined) resync();
      else set(vs);
    });
    return () => {
      alive = false;
      off();
      void window.api.watchOverview(false);
    };
  }, []);
  return v;
}

export function useUsage(): UsageView | null {
  const [u, set] = useState<UsageView | null>(null);
  useEffect(() => {
    void window.api.getUsage().then(set);
    return window.api.onUsage(set);
  }, []);
  return u;
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
