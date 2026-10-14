# Performance

Goal: stay smooth with 300+ agents over hours-long sessions.

## Benchmark

`tests/e2e/perf.test.ts` (skipped unless `PERF=1`) launches the **built** app (`npx electron-vite build` first) against a synthetic session from
`tests/fixtures/large.ts`: 300 subagents, 30k tool calls (about 36 MB of transcripts), 40 agents still running, plus a live-append mode that keeps
writing 30 tool calls every 500 ms for 20 s (`PERF_SECONDS`). It runs three scenarios:

| scenario | what it shows |
| --- | --- |
| `synthetic-live` | default view: finished agents collapsed (42 cards), live appends |
| `synthetic-live-expanded` | the user clicked "N finished": all 301 cards on screen, live appends |
| `real-idle` (needs `PERF_REAL=1`) | the biggest real session on this machine, `02d785f3-40f3-4031-9659-a2a414e7dc1b` (292 agents, read-only), selected and left open |

```
npx electron-vite build
$env:PERF='1'; $env:PERF_LABEL='after'; $env:PERF_REAL='1'; $env:E2E_PORT='47915'
npx vitest run --config vitest.e2e.config.ts tests/e2e/perf.test.ts
```

Results go to `tests/e2e/artifacts/perf-<label>.json` (gitignored). What is measured:

- **first render**: `window.api.select(id)` until the first non-collapsed card has painted
- **IPC payload**: with `CLAUDE_VIS_PERF=1` the main process counts pushes and JSON bytes per channel (`globalThis.__perf`); JSON size is a proxy for the structured-clone cost
- **long tasks** (`PerformanceObserver('longtask')`, > 50 ms) and **frame times** (a `requestAnimationFrame` loop) in the renderer during the live window
- **renderer heap** (`performance.memory`) and **process working sets** (`app.getAppMetrics()`)
- script time as a share of wall time (CDP `Performance.getMetrics`, `scriptPct`)

Unit tests that guard the same properties: `tests/unit/sync.test.ts` (incremental transport reproduces the live view exactly) and
`tests/unit/memory-bounds.test.ts` (an "hour" of appends does not grow the pushed view; reducer bookkeeping is capped).

## Numbers (Windows 11, other builds running in parallel, so treat as +-25 %)

| | before | after |
| --- | --- | --- |
| **synthetic-live** (42 cards) | | |
| IPC bytes per push, average | 1,560,000 | 110,000 to 130,000 |
| long tasks in 20 s | 57 (3.6 s total, max 76 ms) | 0 |
| frame time avg / p95 / max | 15.5 / 50 / 158 ms | 11 / 17 / 33 ms |
| script share of renderer wall time | 20 % | 2.3 % |
| renderer JS heap | 47 MB | 19 MB |
| **synthetic-live-expanded** (301 cards, 40 running) | | |
| IPC bytes per push, average | 1,558,000 | 109,000 to 150,000 |
| long tasks in 20 s | 81 (6.6 s total, max 118 ms) | 0 |
| frame time avg / p95 / max | 57.6 / 133 / 258 ms | 10.3 / 17 / 42 ms |
| script share of renderer wall time | 25 % | 2.5 % |
| renderer JS heap | 47 MB | 31 MB |
| **real session, 292 agents, idle** | | |
| first render after select | 1.9 to 8 s (noisy) | 2.0 to 2.6 s |
| long tasks in 20 s idle | 0 to 48 (up to 2.8 s) | 0 |
| renderer JS heap | 29 MB | 14 to 16 MB |
| renderer working set | 373 MB | 185 to 215 MB |
| full first push | 1.38 MB | 1.38 MB (unchanged, sent once) |

The "real idle" long tasks in the before runs are one-time render cost of the full-state pushes plus the per-second `now` tick re-rendering every card.
The first push is still the whole view (1.4 to 1.5 MB); only later pushes are incremental.

## What changed

1. **Incremental IPC** (`src/core/sync.ts`). The `state` and `overview` channels no longer carry a `SessionView`; they carry a `ViewMsg`:
   `{t:'full', seq, view}` for the first push, after a window asks for a snapshot, when the session changes or when the file was rebuilt, otherwise
   `{t:'delta', seq, base, id, meta?, agents?, removed?, log?}`:
   - `agents`: per-field patches for agents whose JSON changed (a whole node for new agents). Change detection is a per-agent `JSON.stringify` compare in the
     main process (about 5 ms for 300 agents, once per 200 ms push), so there is no list of fields to keep in sync with the reducer.
   - `log`: only entries newer than the last one sent. `meta`: the other top-level fields (todos, plan, totals...), only when changed.
   - `ViewDecoder` (renderer) rebuilds an ordinary `SessionView`, **keeping object identity** for unchanged agents and the unchanged log array, which is what
     makes `React.memo` effective. A message that does not fit (`base !== seq`, other session) makes the hook call `getState()`, which also forces the next
     push to be full. `window.api.getState()` / `getOverview()` still return plain views; only `onState` / `onOverview` payloads changed.
   - Replay builds its views locally, now through the same codec (`LocalViewStream`, with a `structuredClone` standing in for the IPC copy), so replay
     views have the same identity behaviour and old frames cannot be mutated by the reducer.
   - The overview keeps one encoder per session (`OverviewEncoder` / `OverviewDecoder`), so N big live sessions no longer re-send N full states every 500 ms.
2. **Graph**. The layout is memoized on a structural key (id, parent, status, start time per agent); the edge layer is `memo`; child counts are computed once
   per push instead of per card (was O(n^2)); `NodeCard` is `memo` and gets its time-dependent text through a small clock store (`renderer/clockStore.ts`):
   a card re-renders when its agent object changes or when the text it would show (status, elapsed, "now" phrase and duration, sparkline) changes, not on every
   one-second tick.
3. **Paint cost**, which turned out to dominate once script time was gone: animating `stroke-dashoffset` on 40 active edges and `background-position` on the
   progress stripes repainted large areas every frame. The stripes now slide by `transform` (same look, compositor), the dashes step at 8 fps and the travelling
   dots are limited to the first 16 active edges when more than 16 agents run. With 16 or fewer active edges nothing looks different.
4. **Log**. Fixed 20 px rows, only the rows in view (plus 10 overscan) are in the DOM, stick-to-bottom kept; the filtered, sorted list is memoized on the log
   array identity and the filters; the agent dropdown is memoized on the agent set. The panel still shows the latest 600 matching entries.
5. **Bounded memory**. Already capped: log (1500), `activity` (120), `recent` (10), `files` (30), `commands` (10), prompt (600 chars). Added: `internal.seenTools`
   (40k entries; entries still needed for parent resolution, pending calls or the plan are never dropped) and `internal.usage[agent]` (500 messages), which
   grew by about 100 bytes per tool call in the main process. `tests/unit/memory-bounds.test.ts` checks both.

## Not done / notes

- Watcher polling: with one 292-agent session open, main-process CPU is about 0.5 %, so the per-agent `stat` storm was not reduced. It scales with
  (live sessions x agents) at 600 ms; revisit if that ever shows up.
- Time to first render of a huge session is dominated by the worker's backlog read and fold (1.6 s for the 292-agent session), not by rendering.
- The first full push of a 300-agent session is still about 1.5 MB. Dropping `activity` / `recent` / `files` from it and fetching them when the drawer opens
  would cut it by roughly half, at the cost of changing what consumers can rely on in `AgentNode`.
