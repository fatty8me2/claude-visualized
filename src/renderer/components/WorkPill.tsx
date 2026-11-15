import { WORK_HELP, type WorkCounts } from '@core/work';

/**
 * "● 3 working · 2 idle": how many agents are doing something right now, and how many are open but doing nothing themselves
 * (see core/work.ts). Lit and pulsing while anything works, flat when nothing does.
 */
export function WorkPill({ c, size = 'md', noun }: { c: WorkCounts; size?: 'sm' | 'md' | 'lg'; noun?: string }) {
  return (
    <span
      className={`wk-pill wk-${size} ${c.working > 0 ? 'wk-on' : 'wk-off'}`}
      data-testid="work-pill"
      data-working={c.working}
      data-idle={c.idle}
      title={`${c.working} of ${c.total} agent${c.total === 1 ? '' : 's'} working, ${c.idle} idle, ${c.finished} finished.\n${WORK_HELP}`}
    >
      <span className="wk-dot" aria-hidden />
      <b className="wk-n">{c.working}</b>
      <span className="wk-w">{noun ? `${noun} ` : ''}working</span>
      {c.idle > 0 && (
        <span className="wk-idle">
          <b>{c.idle}</b> idle
        </span>
      )}
    </span>
  );
}
