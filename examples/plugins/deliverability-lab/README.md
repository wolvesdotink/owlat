# Deliverability Lab — reference plugin (Tiers 1, 2, and 3)

A reference Owlat plugin that runs pre-send deliverability checks and holds a
campaign that would ship red. It exercises all three plugin tiers against the
real contribution contracts in `@owlat/plugin-kit` and the PP-27 sandboxed
worker — no stubs.

## What it does

The same deterministic engine (`src/engine/`) powers every tier:

- **Spam score** — SpamAssassin-style static rules (shouty subject, trigger
  phrases, image-only body, missing plain-text part).
- **Link audit** — insecure `http://`, bare-IP/localhost hosts, display/target
  mismatch, and (advisory) missing UTM tags.
- **Accessibility audit** — images without `alt`, empty-text links, missing
  document language.

## How the three tiers show up

| Tier | Contribution | Module | Security posture |
| ---- | ------------ | ------ | ---------------- |
| 1 (bundled, in-process) | `sendGates` restrict-only preflight gate, plus `navItems` / `settingsPanels` UI and a budgeted `crons` tip job | `src/gate.ts`, `src/cron.ts` | The gate's only results are `no-objection` / `objection`; any internal error becomes an objection. It can hold a send, never force one. |
| 2 (connected hook) | An optional seedbox `score` hook, consumed with a deadline and a fail-closed fallback to local scoring | `src/remoteScore.ts` | The vendor answer is untrusted: strictly validated to a bounded `[0,1]` score, and on timeout/failure/invalid response the gate falls back to the local score. A remote answer can only ADD caution. |
| 3 (sandboxed worker) | A seed-list placement test enqueued as `plugin.deliverability-lab.seed-test` | `src/seedTest.ts` (plugin side) + `apps/code-worker/src/jobs/seedTest.ts` (host-controlled worker command) | The job runs under the PP-27 sandbox (separate uid, no ambient credentials, wall-clock budget); the untrusted payload is passed as a discrete argv element and the result is byte-bounded. |

`llm:invoke` usage (the tip cron) goes through the host's attributed dispatch and
is capped by the manifest's hard daily budget.

## Layout

```
src/
  manifest.ts     definePlugin() — capabilities, flag, budget, contributions, settings
  engine/         pure, deterministic spam / link / accessibility analysis
  gate.ts         Tier-1 restrict-only send gate (composes Tier-2 escalation)
  remoteScore.ts  Tier-2 seedbox score consumption + strict validation + fallback
  seedTest.ts     Tier-3 enqueue payload builder + result parser (plugin side)
  cron.ts         budgeted deliverability-tip cron (llm:invoke)
  insights.ts     pure LLM prompt builder
```

The Tier-3 worker command lives in `apps/code-worker` (host-controlled — the
worker image never loads plugin code). The plugin/worker wire is pinned by
`fixtures/deliverability-lab/seed-test-payload.json`, which both test suites read.

## Tests

```sh
cd examples/plugins/deliverability-lab && npx vitest run
cd apps/code-worker && npx vitest run src/__tests__/seedTest.test.ts
```
