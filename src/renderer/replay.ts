import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@core/events';
import { apply } from '@core/reducer';
import { newSession, toView, type SessionState, type SessionView } from '@core/state';

export interface Replay {
  sessionId: string;
  events: AgentEvent[];
  idx: number;
  playing: boolean;
  speed: number;
  view: SessionView;
  now: number;
}

/** Long silences are skipped during playback so replays stay watchable. */
const MAX_GAP_MS = 4000;

export function useReplay() {
  const [replay, setReplay] = useState<Replay | null>(null);
  const stateRef = useRef<{ s: SessionState; idx: number } | null>(null);

  const seek = useCallback((events: AgentEvent[], sessionId: string, idx: number) => {
    let cur = stateRef.current;
    if (!cur || idx < cur.idx) cur = { s: newSession(sessionId), idx: 0 };
    for (let i = cur.idx; i < idx; i++) apply(cur.s, events[i]);
    cur.idx = idx;
    stateRef.current = cur;
    return toView(cur.s);
  }, []);

  const start = useCallback(
    async (sessionId: string) => {
      const events = await window.api.replayEvents(sessionId);
      stateRef.current = null;
      const view = seek(events, sessionId, 0);
      setReplay({ sessionId, events, idx: 0, playing: true, speed: 8, view, now: events[0]?.ts ?? Date.now() });
    },
    [seek],
  );

  const stop = useCallback(() => {
    stateRef.current = null;
    setReplay(null);
  }, []);

  const goto = useCallback(
    (idx: number) => {
      setReplay((r) => {
        if (!r) return r;
        const i = Math.max(0, Math.min(r.events.length, idx));
        const view = seek(r.events, r.sessionId, i);
        return { ...r, idx: i, view, now: r.events[Math.max(0, i - 1)]?.ts ?? r.now };
      });
    },
    [seek],
  );

  const setPlaying = (playing: boolean) => setReplay((r) => (r ? { ...r, playing } : r));
  const setSpeed = (speed: number) => setReplay((r) => (r ? { ...r, speed } : r));

  // playback clock: advance simulated time, apply every event up to it
  useEffect(() => {
    if (!replay?.playing) return;
    const tick = 100;
    const t = setInterval(() => {
      setReplay((r) => {
        if (!r || !r.playing) return r;
        if (r.idx >= r.events.length) return { ...r, playing: false };
        let now = r.now + tick * r.speed;
        const next = r.events[r.idx];
        if (next && next.ts - r.now > MAX_GAP_MS) now = next.ts;
        let i = r.idx;
        while (i < r.events.length && r.events[i].ts <= now) i++;
        if (i === r.idx) return { ...r, now };
        const view = seek(r.events, r.sessionId, i);
        return { ...r, idx: i, now, view };
      });
    }, tick);
    return () => clearInterval(t);
  }, [replay?.playing, seek]);

  return { replay, start, stop, goto, setPlaying, setSpeed };
}
