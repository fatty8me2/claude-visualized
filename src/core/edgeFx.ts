// Which edges should play a one-off animation, from a diff of agent statuses.

const LIVE = new Set(['running', 'waiting', 'idle', 'quiet']);

export interface EdgeFxPlan {
  /** children that appeared while watching */
  spawn: string[];
  /** children that finished while watching */
  ret: { id: string; err: boolean }[];
}

/**
 * `prev` is null on first sight of a session (and when the session changes): nothing animates, so opening a session with 300 finished
 * agents is quiet. A diff that changes more than `maxBatch` agents (replay scrubbing, a rebuilt file) is treated as a jump, not a story.
 * Only forward events animate: a finished agent turning live again (scrubbing back) or disappearing does nothing.
 */
export function diffEdgeFx(prev: ReadonlyMap<string, string> | null, next: ReadonlyMap<string, string>, maxBatch = 4): EdgeFxPlan {
  const plan: EdgeFxPlan = { spawn: [], ret: [] };
  if (!prev) return plan;
  for (const [id, st] of next) {
    const was = prev.get(id);
    if (was === undefined) {
      if (LIVE.has(st)) plan.spawn.push(id);
    } else if (LIVE.has(was) && (st === 'done' || st === 'error')) {
      plan.ret.push({ id, err: st === 'error' });
    }
  }
  if (plan.spawn.length + plan.ret.length > maxBatch) return { spawn: [], ret: [] };
  return plan;
}
