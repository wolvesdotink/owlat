# Landing the 8 open deliverability follow-up PRs onto main

Working note, 2026-08-08. Root-level plan files are gitignored in this repo.

## Context

The 8 open PRs (#523, #524, #526, #527, #529, #530, #531, #532) all targeted
`integration/deliverability`, which was squash-merged into main via #461 on
2026-08-04. The integration tip (162ebd1a) predates that merge, so **main
already contains everything on the integration branch** — the 8 PRs are pure
follow-ups. Main has since gained #521 (Mandrill provider), which touches the
same delivery area.

Every PR was reviewed (7 parallel review agents + direct review of the ADR),
every PR applies cleanly to current main individually, and the plan is to land
all 8. Mechanics per PR: rebase branch onto main (`git rebase --onto
origin/main 162ebd1a <branch>`), push, retarget PR base to main via REST
(`gh api repos/wolvesdotink/owlat/pulls/<n> -X PATCH -f base=main` — `gh pr
edit --base` is broken by a deprecated projectCards GraphQL field), wait for
the required `Test Summary` check, `gh pr merge <n> --squash --delete-branch`.

## Landing order and why

**523 → 524 → 526 → 527 → 530 → 531 → 532 → 529** (only the last three are
actually order-constrained):

- **#531 before #532**: #532's dashboard `smtpBlocks` read referenced the
  7-day `evaluationWindow` identifier that #531 deletes; grading gate 2 over
  the reported window would reintroduce the #510 dashboard/controller
  divergence. Resolved during rebase: the read now uses #531's
  `decisionWindow` (identical to the cron's `now - RAMP_WINDOW_MS`).
- **#532 before #529**: #532 edits prose in `ramp/sndsGate.ts` and
  `sndsAbsent.test.ts`, which #529 deletes/guts. The conflict is purely
  textual (the SNDS gate is unrelated to gate 2's block clause); deletion
  supersedes prose edits.
- Everything else is file-disjoint or region-disjoint.

## Review verdicts and findings

- **#523 (ADR 0054, ramp controller)** — MERGE. Docs-only; numbering correct
  (0054 free on main, 0055 taken by #521's ADR); all cited modules/fixtures
  exist on main. **MERGED.**
- **#524 (delete `getGateVerdict`)** — MERGE. Dead parallel seed-corroboration
  route, verified no callers on main; coverage moved correctly. Minor: the
  shared corroboration rule's only production route is now via a function with
  no production caller (acknowledged deferral, issue-tracked). **CI running.**
- **#526 (independence screen keys on relay existence)** — MERGE after fix.
  Core fix correct and the bug is live on main; works correctly with #521's
  Mandrill relay. Review found one in-scope miss: `useRelayRemovalGuard.ts`
  still keyed on `referenceTransportId !== null`, leaving the client-side
  confirmation dialog dead on the env-relay shape (server guard still catches
  it). **Fixed in a fixup commit** (predicate now keys on `relayRemoval.kind
  === 'unsafe'` alone + two test changes: honest never-had-a-relay fixture,
  new env-relay regression case). One CI round-trip was lost to `lint:format`
  (oxfmt must run with `--config oxfmtrc.json`). **MERGED** (squash, includes
  fixup).
- **#527 (unreadable lease ≠ expired lease)** — MERGE. Wire code defined once
  in shared, 409 discrimination sound, both deferral origins test-pinned.
  Fixed its docs nit in a fixup (EmailErrorCode list now names all 11
  members). **Deploy-order note: deploy apps/api before/with apps/mta** — a
  new MTA + old Convex terminalizes the new 409 instead of deferring.
  **CI running.**
- **#530 (transactional/automation seed probe)** — MERGE. Probe-leak check
  clean, schema widening strictly additive, cron correct. Four non-blocking
  hardening minors noted by review (D18 assert keys on `seedProbeId` but not
  `seedProbeRef`; empty-org fallback in the one-click token scope;
  `latestSeedProbePassAt` scan-limit under 3× row volume; dispatch leg of the
  D18 denominator not integration-tested). Candidates for a follow-up issue,
  not fixed here. **CI running.**
- **#531 (dashboard grades over the controller's window)** — MERGE. Verified
  it uses the same `RAMP_AIMD.evaluationWindowMs` constant and summarizer as
  the cron (no re-derived copy). Minors: midnight-straddle flake window in the
  rewritten agreement test; `cleanStreakIncludingThisWindow` doc-name drift.
  **CI running.**
- **#532 (classified SMTP responses → gate 2 block clause)** — MERGE. Tenant
  scoping, deletion-walker coverage, rolling-deploy safety in both directions,
  no PII on the wire, no double-counting — all verified. Minors: docs/comments
  overstate ("every 4xx/5xx" — 5xx is never classified, only the deferred
  branch; NOT yet fixed, consider fixing during final rebase or as follow-up);
  outbox slot keyed on `Date.now()` can double-count on crash-replay
  (acknowledged at-least-once); `recordClassifiedResponse` catch-all mislabels
  DB failures as `no_assignment`. **Prepared locally** (see state below).
- **#529 (delete SNDS gate + entry-wiring guard)** — MERGE_AFTER_DEPS.
  Deletion commit fully verified dead on main. The guard had a real bug: the
  same-module exclusion in `callersOf` falsely orphaned live continuations (a
  reached entry scheduling a module-mate, e.g. #521's
  `completeSend → expireUnconfirmedAcceptance`) — it would have FAILED on
  main. **Fixed in a fixup commit**: `reachedEntries()` second pass credits a
  same-module reference iff another entry of the module is reachable
  (fixed-point iteration, fixture-pinned in both directions); 88 of the 238
  ledger lines were this pattern and came off `UNREACHED_ENTRIES` (150
  remain); docblock counts updated. Also reconciled the
  `degradationMatrix.ts`/test prose contradiction with #532 (kept #529's
  "sources are NOT rendered / NOT in the audit row" receipts + #532's
  standalone-evaluator scope rationale). **Prepared locally.**

## Current state (as of stopping)

Merged into main (squash):
1. **#526** — merged 08:49 UTC.
2. **#523** — merged ~08:52 UTC.

Open, CI (`pull_request` runs) in flight; merge each on `Test Summary=pass`
(mergeState UNSTABLE is fine — see Security note below):
3. **#524** — branch `fix/dlv-seed-parallel-route`, rebased onto main, pushed.
4. **#527** — branch `fix/dlv-lease-unreadable`, rebased + docs fixup, pushed.
5. **#530** — branch `fix/dlv-transactional-seed-probe`, rebased, pushed.
6. **#531** — branch `fix/dlv-dashboard-span`, rebased, pushed.

Prepared locally in the worktree `/tmp/owlat-stack` (NOT pushed yet):
7. **#532** — local branch `wip/532-rebased` = the 5 PR commits rebased onto
   `fix/dlv-dashboard-span` (#531), with the one conflict resolved
   (`deliverabilityDashboard.ts`: smtpBlocks read moved to `decisionWindow`).
   `git rerere` is enabled in the worktree, so redoing the rebase onto real
   main after #531 merges replays the resolution.
8. **#529** — local branch `wip/529-rebased` (= `fix/dlv-entry-wiring-guard`)
   on top of `wip/532-rebased`: delete-vs-edit conflicts resolved (deletion
   wins), degradationMatrix prose reconciled, guard fix + ledger prune
   committed, oxfmt-clean.

Local verification already done on the combined 531+532+529 stack: the
targeted api suites (64 wiring/dashboard tests), entryWiring guard 27/27, both
hidden ramp matrix legs (`OWLAT_RAMP_GATE_MATRIX_MODE=reference_arm|standalone`),
382 web delivery tests, full `apps/api` lint chain incl. codegen check.

## Remaining steps

1. When #524/#527/#530/#531 report `Test Summary=pass`:
   `gh pr merge <n> --squash --delete-branch` (any order among 524/527/530;
   531 whenever ready — 532 just has to come after it).
2. After #531 merges: in `/tmp/owlat-stack`,
   `git checkout fix/dlv-smtp-block-telemetry && git fetch origin && git rebase --onto origin/main <old-531-tip> fix/dlv-smtp-block-telemetry`
   — or simpler, re-run `git rebase --onto origin/main 162ebd1a` on the
   original branch and let rerere replay the dashboard resolution. Verify:
   smtpBlockWiring/seedGateWiring/dashboard tests + `scripts/check-format.sh`.
   Push, retarget #532 to main (REST PATCH), wait for Test Summary
   (close/reopen the PR if Actions doesn't trigger — see gotchas), merge.
3. After #532 merges: same for `fix/dlv-entry-wiring-guard` (#529). Re-run
   `convex/__tests__/entryWiring.test.ts` after the rebase — merged siblings
   change entry reachability, and the exact two-direction ledger may need a
   line added/removed (e.g. #524 deleted `getGateVerdict`; #530/#532 added
   wired entries). Then push, retarget, CI, merge.
4. Delete the leftover local artifacts: worktree `/tmp/owlat-stack`
   (`git worktree remove`), `refs/prbatch/*` refs, `wip/*` branches.
5. Optional follow-ups worth filing: #530's four hardening minors; #532's
   "every 4xx/5xx" doc overstatement; #526's `unstubEnvs: true` suggestion for
   the api vitest config; #527's api-before-mta deploy-order note in release
   docs.

## Gotchas hit (also useful next time)

- **GitHub Actions did not trigger** on the first force-push +
  base-retarget round (zero runs for the pushed SHAs; base-change `edited`
  events never trigger workflows, and the `synchronize` runs silently never
  materialized). Workaround: `workflow_dispatch` runs satisfy nothing on the
  PR (check suites don't attach to the PR rollup → mergeState stays BLOCKED);
  what works is forcing a fresh `pull_request` event — push a new commit, or
  `gh pr close <n> && gh pr reopen <n>`.
- **`lint:format` (oxfmt) is a ratchet on touched JS/TS files**; run
  `./node_modules/.bin/oxfmt --config oxfmtrc.json <files>` before committing
  fixups (bare `npx oxfmt` uses wrong defaults and makes it worse).
- **Security workflow is red on every branch and on main itself** — the
  advisory audit gate (scripts/check-security-audit.ts) trips on four
  unacknowledged GHSAs: GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8,
  GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr. Pre-existing, unrelated to these
  PRs, not a required check (only `Test Summary` is required on main).
  Needs a separate dependency-lift PR like #516.
- `gh pr edit --base` fails on the deprecated projectCards GraphQL field; use
  the REST PATCH instead.
