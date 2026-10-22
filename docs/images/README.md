# Screenshots for the README

The README references these files. Add them here as PNG images; the README links them by these exact names.

| file | what to show | used in README |
| --- | --- | --- |
| `session-graph.png` | One live session: the agent graph with the plan rail beside it | Screenshots section |
| `overview.png` | The all-sessions overview with two or more panels | Screenshots section |
| `inbox.png` | The attention inbox with one permission prompt | Screenshots section |
| `empty-state.png` | A fresh install with no sessions yet (the main empty view) | Screenshots section |
| `plan-rail.png` | The plan rail, with a step hovered and its agent lit up | optional |
| `mode-panel.png` | The mode panel: PLAN or BUILD, the task checklist and token totals | optional |
| `welcome.png` | The first-launch welcome checklist | optional |
| `hooks-dialog.png` | The hooks dialog with its before and after preview | optional |
| `mini-view.png` | The always-on-top mini view | optional |

Tips:

- The end-to-end suite already writes screenshots of the fixture data to `tests/e2e/artifacts/` (for example `fixture.png`, `overview.png`, `inbox.png`, `plan-rail.png`, `hooks-dialog.png`, `welcome.png`, `mini.png`, `empty-main.png`). Those show made-up sessions and are safe to publish.
- Do not publish the `real*.png` files that a `SHOT_REAL=1` run writes: they show your own, real sessions.
- Use a width of about 1440 px and the dark theme, and keep the window free of file paths or project names you don't want shared.
