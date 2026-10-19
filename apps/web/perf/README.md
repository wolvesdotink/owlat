# Component performance scenarios

Report-only measurements of real web components in a real browser. They are not
a test and not part of CI: nothing here passes or fails on a number.

```sh
bun run --cwd apps/web perf:scenarios                      # every scenario, 5 runs each
bun run --cwd apps/web perf:scenarios --only chat-history  # one family (or a scenario id)
bun run --cwd apps/web perf:scenarios --repeats 10 --cpu-throttle 4 --headed
```

Needs system Chrome (Playwright `channel: 'chrome'`). No backend, credentials or
sign-in: each scenario mounts components with synthetic props.

## What runs

`perf/vite.config.ts` builds `perf/fixture/` for production with the app's own
Vue and Tailwind setup. The runner (`perf/run.ts`) serves that build, opens a
fresh page per run, and calls the page's `window.__owlatPerf`
(`perf/fixtureApi.ts`): mount, run, unmount. Between calls it reads Chrome's
counters over the DevTools protocol, with a forced garbage collection before
the baseline and after teardown.

| Scenario                    | Components                                                                                | Workload                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `assistant-stream/start`    | `AssistantMessage` list under the assistant page's scroll container and `useFollowLatest` | answer streams from empty, one write per 250 ms, under 20 settled turns |
| `assistant-stream/near-cap` | same                                                                                      | the last 12 s of an estimated near-cap answer (see below)               |
| `chat-history/500`          | `ChatMessageList` (and every `ChatMessage`)                                               | a room's full 500-message window, scrolled newest to oldest             |

The limits the workloads obey live in `scripts/perf-scenarios/writerLimits.ts`.
`apps/api/convex/__tests__/perfScenarioWriterLimits.integration.test.ts` checks
each one against the real backend (the task policy's output ceiling, the
runner's write cadence, the questions and messages the mutations accept, the
history the queries return), and it runs in CI.

The near-cap answer is an estimate. It is 32,768 characters: the 8,192-token
output cap at an assumed 4 characters a token. Nothing is tokenized, so a real
answer at the cap may be shorter or longer than that.

## Reading the report

The report goes to stdout and to `node_modules/.cache/owlat-perf/reports/`
(Markdown, plus JSON with every run's raw values).

- **Counters** are work done: component updates by name, DOM mutations, layouts
  and style recalcs, and the DOM nodes, listeners, documents and frames left
  after teardown. "Same every run" says whether a counter was deterministic.
- **Timings** are wall-clock on the recorded machine, with stdev and CV across
  runs. Compare them only between runs on the same machine.
- A **VOID** scenario did not render the real components cleanly (an error, an
  unresolved component, a missing message key). The run exits 1 and its numbers
  mean nothing.

## Fidelity limits

- Not the Nuxt app: no router, layouts, plugins or Convex client. Nuxt's
  auto-imports are installed as globals (`fixture/autoImports.ts`), and
  `useConvex` returns no client, so the real `useConvexQuery` never subscribes.
- `Icon` is a stand-in `<span>`, as @nuxt/icon's CSS mode renders. Fonts are the
  system fallback, because @nuxt/fonts is a Nuxt module.
- vue-i18n compiles messages at runtime here; the app precompiles them.
- Authenticated full-route scenarios are out of scope. They depend on how
  route fixtures get delivered, which is still undecided.
