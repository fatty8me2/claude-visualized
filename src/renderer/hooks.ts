import { useEffect, useState } from 'react';
import type { AppConfigView, HookServerStatusView, PeersView } from '@core/api';
import type { InboxSnapshot } from '@core/inbox';
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

/** The session list; null until the first answer arrives (so pages don't flash "no sessions"). */
export function useSessions(): SessionSummary[] | null {
  const [s, set] = useState<SessionSummary[] | null>(null);
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
    let retry: ReturnType<typeof setTimeout> | null = null;
    const resync = () => {
      if (fetching) return;
      fetching = true;
      window.api
        .getState()
        .then((v) => {
          if (!alive) return;
          dec.adopt(v);
          set(v);
        })
        .catch((e) => {
          console.error('getState failed', e);
          if (alive) retry = setTimeout(resync, 1500);
        })
        .finally(() => {
          fetching = false;
        });
    };
    const off = window.api.onState((m) => {
      if (fetching) return;
      const v = dec.apply(m);
      if (v === undefined) resync();
      // "no view" arrives between selecting a session and its first snapshot: keep the last one on screen meanwhile
      // (App shows it with a loading strip, so the page doesn't unmount and lose its tabs and filters)
      else if (v !== null) set(v);
    });
    resync();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
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
    let retry: ReturnType<typeof setTimeout> | null = null;
    const resync = () => {
      if (fetching) return;
      fetching = true;
      window.api
        .getOverview()
        .then((vs) => {
          if (!alive) return;
          dec.adopt(vs);
          set(vs);
        })
        .catch((e) => {
          console.error('getOverview failed', e);
          if (alive) retry = setTimeout(resync, 1500);
        })
        .finally(() => {
          fetching = false;
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
      if (retry) clearTimeout(retry);
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

/** The attention inbox (all sessions), pushed by the main process. */
export function useInbox(): InboxSnapshot | null {
  const [s, set] = useState<InboxSnapshot | null>(null);
  useEffect(() => {
    void window.api.getInbox().then(set);
    return window.api.onInbox(set);
  }, []);
  return s;
}

/** Peer link state: sharing, pairing code, paired and discovered computers. */
export function usePeers(): PeersView | null {
  const [p, set] = useState<PeersView | null>(null);
  useEffect(() => {
    void window.api.getPeers().then(set);
    return window.api.onPeers(set);
  }, []);
  return p;
}
