# Component performance scenarios

Measurements of real web components in a real browser, with committed budgets
for the counters that come out the same on every run. A run fails when any
run of any scenario breaks one of them (`perf/budgets.ts`); timings are
reported and never fail anything.

```sh
bun run --cwd apps/web perf:gate                           # every scenario, 3 runs each: the CI gate
bun run --cwd apps/web perf:scenarios                      # every scenario, 5 runs each
bun run --cwd apps/web perf:scenarios --only postbox-list  # one family (or a scenario id)
bun run --cwd apps/web perf:scenarios --repeats 10 --cpu-throttle 4 --headed
```

CI runs `perf:gate` nightly, on dispatch and on pull requests that touch
`perf/` (`.github/workflows/perf.yml`), and keeps the report as an artifact.

Needs system Chrome (Playwright `channel: 'chrome'`). No backend, credentials or
sign-in: each scenario mounts components with synthetic props.

## What runs

`perf/vite.config.ts` builds `perf/fixture/` for production with the app's own
Vue and Tailwind setup. The runner (`perf/run.ts`) serves that build, opens a
fresh page per run, and calls the page's `window.__owlatPerf`
(`perf/fixtureApi.ts`): mount, run, unmount. Between calls it reads Chrome's
counters over the DevTools protocol, with a forced garbage collection before
the baseline and after teardown.

Every run's context is pinned (`perf/browserContext.ts`): 1280×800 at 1×, light,
timezone `UTC`, locale `en-US`, and `Date.now()` at 2026-09-15 12:00 UTC. The
runner checks that the page really runs in that timezone, locale and clock,
and refuses the run otherwise. The pins matter because the chat list groups
messages by calendar day in the browser's timezone (the same 500 messages make
15 date groups in UTC and 14 in Pacific/Gambier), and the mail lists print
each row's age and the Team Inbox's waiting chips against the current time.
Only `Date` is pinned: timers and animation frames run at real speed.

| Scenario                    | Components                                                                                | Workload                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `assistant-stream/start`    | `AssistantMessage` list under the assistant page's scroll container and `useFollowLatest` | answer streams from empty, one write per 250 ms, under 20 settled turns |
| `assistant-stream/near-cap` | same                                                                                      | the last 12 s of an estimated near-cap answer (see below)               |
| `chat-history/500`          | `ChatMessageList` (and the `ChatMessage` rows its window mounts)                          | a room's full 500-message window, scrolled newest to oldest             |
| `postbox-list/50`           | `PostboxThreadList` (and every `PostboxThreadRow`) in the Postbox list pane               | one folder page, under the windowing threshold: one row read, scrolled  |
| `postbox-list/500`          | same, with its windowing                                                                  | ten folder pages, over the threshold: one row read, scrolled to the end |
| `team-inbox/100`            | `InboxThreadRow` rows in the Team Inbox page's listbox and keyboard model                 | four pages of threads: one thread read, one tick of the list clock      |

The limits the workloads obey live in `scripts/perf-bench/scenarioWriterLimits.ts`.
`apps/api/convex/__tests__/perfScenarioWriterLimits.integration.test.ts` checks
each one against the real backend (the task policy's output ceiling, the
runner's write cadence, the questions and messages the mutations accept, the
history the queries return), and it runs in CI. Turbo's generic `test`,
`test:coverage` and `typecheck` inputs hash `scripts/perf-bench/**`, so a change
to the limits re-runs both workspaces' tests and typechecks instead of
replaying a cached result.

The near-cap answer is an estimate. It is 32,768 characters: the 8,192-token
output cap at an assumed 4 characters a token. Nothing is tokenized, so a real
answer at the cap may be shorter or longer than that.

Each mail list scenario delivers its rows the way the live query does (parsed
JSON through `shareStructure`), then delivers them again with one row changed,
so the counters show how much of the list one changed row re-renders. Each
also proves its workload landed: the changed row really reads as read, and the
Postbox scroll passes every row (`rows shown while scrolling`), so a fixture
that renders less cannot pass its budgets by doing less work.

## Budgets

`perf/budgets.ts` holds, per scenario, a ceiling (`max`) for work counters and
an identity (`exact`) for what the workload has to deliver. Every run is
checked on its own. A scenario that runs without budgets, a budgeted counter a
run did not measure, and a value that is not a number all fail too.

Only counters that held across repeated runs and do not depend on the machine
carry a budget. Layout and style-recalc counts follow Chrome's frame
scheduling; Chrome's own node count at mount follows its internals (the
page-side `elements rendered` is budgeted instead); the scroll height and
scroll frames of variable-height rows follow the installed fonts, and so does
everything the windowed chat list mounts and re-renders (its rows, its window
moves); the windowed Postbox list's own re-renders while scrolling vary by a
few with when its scroll handler's animation frame lands (its rows
re-rendering is budgeted, at 0). Those stay report-only.

A change that moves a budgeted counter on purpose (a new element per row, a
row that now re-renders for a reason) updates the budget in the same change
and says why in its description. To re-measure: run
`perf:scenarios --repeats 10`, check the "Same every run" column, and take the
values from the report's counter tables. Lower a ceiling when a counter drops;
that is how the gate tightens.

The Postbox scenarios' teardown budgets are not zero today because of a known
retention in the app, not in the fixture: the first list mounted on a page
stays alive after it unmounts.
`usePostboxOfflineCache` registers its app-wide `online`/`offline` listeners
inside the composable, so the listeners keep the first caller's scope, and with
it that list, alive. Fixing it brings those budgets to 0.

## Reading the report

The report goes to stdout and to `node_modules/.cache/owlat-perf/reports/`
(Markdown, plus JSON with every run's raw values).

- **Budgets** come first: every breach, by scenario, counter and run, or a
  line saying every run held.
- **Counters** are work done: component updates by name, DOM mutations, layouts
  and style recalcs, and the DOM nodes, listeners, documents and frames left
  after teardown. "Same every run" says whether a counter was deterministic;
  "Budget" shows the committed ceiling (≤) or identity (=).
- **Timings** are wall-clock on the recorded machine, with stdev and CV across
  runs. Compare them only between runs on the same machine.
- A **VOID** scenario did not render the real components cleanly (an error, an
  unresolved component, a missing message key). The run exits 1 and its numbers
  mean nothing.

## Fidelity limits

- Not the Nuxt app: no router, layouts, plugins or Convex client. Nuxt's
  auto-imports are installed as globals (`fixture/autoImports.ts`), and
  `useConvex` returns no client, so the real `useConvexQuery` never subscribes
  and the real `useBackendOperation` never sends. Nuxt's route, router, keyed
  state and config are stand-ins (`fixture/runtimeGlobals.ts`): a Postbox inbox
  route, navigation that goes nowhere.
- `NuxtLink` renders its `<a href>` without the router's prefetch of links
  scrolling into view (`fixture/nuxtComponents.ts`).
- The Team Inbox scenario rebuilds the page's list around the real rows; the
  page itself needs its signed-in queries.
- Fonts are the system fallback, because @nuxt/fonts is a Nuxt module.
- vue-i18n compiles messages at runtime here; the app precompiles them.
- Authenticated full-route scenarios are out of scope. They depend on how
  route fixtures get delivered, which is still undecided.
