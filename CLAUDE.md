# Claude Code Instructions

## Ways to hurt yourself

Several agents and dev servers usually share one machine, one Docker daemon and
one git object store. Each of these has cost a run before:

1. **Killing by pattern.** Never `pkill -f`, `pgrep <pattern> | xargs kill`,
   or kill a PID you found by matching a name, path or worktree string. Your
   own agent's command line contains the worktree path, and other worktrees run
   the same scripts. Kill only a PID you captured when you started the
   process, or the owner of your port from `ss -H -ltnp` after confirming
   `/proc/<pid>/cwd` is your worktree.
2. **Running the updater against the host Docker daemon.** Never run
   `scripts/e2e-update-flow.sh`, the updater, or
   `docker system|image|volume prune` on the machine's own daemon. The script
   names its compose project `owlat`, like a production install, and ends with
   `docker compose down -v`. The updater's reclaim step prunes every dangling
   image and the unused images of the stack's repositories, whoever pulled
   them. Run the update flow inside a `docker:dind` container, or leave it to
   `update-flow.yml` in CI.
3. **Formatting or staging the whole tree.** Never bare `npx oxfmt` or
   `bunx oxfmt` (both ignore `oxfmtrc.json` or fetch another version), and
   never `bun run ox:fmt` followed by `git add -A`. The repo predates its
   formatter config, so a whole-tree run rewrites several hundred files you did
   not touch. Format the files you changed with
   `./node_modules/.bin/oxfmt --config oxfmtrc.json <paths>`, check with
   `bun run lint:format`, and stage paths by name.
4. **Throwing away someone else's work.** Never `git checkout -- <file>`,
   `git restore` or `git reset --hard` a file you did not change. In a shared
   checkout it may hold another session's uncommitted edits. Never bare
   `git stash` / `git stash pop` either, because every worktree of the
   repository shares one stash stack. Set work aside with a WIP commit.
5. **Filling `/tmp`.** On many dev hosts `/tmp` is a RAM-backed tmpfs with a
   quota. Builds, Playwright traces, Docker contexts and second checkouts fill
   it. Writes then fail with `ENOSPC` or `EDQUOT`, and the files take memory
   from everything else. Point `TMPDIR` and scratch files at disk (for example
   under `~/.cache/`), and add a second worktree next to this one, not in
   `/tmp`.
6. **Trusting `ci:lint` for types.** `bun run ci:lint`
   (`scripts/ci-gate.sh lint`) runs no typecheck, so a green lint gate says
   nothing about types. Run the touched workspace's `typecheck` script, or
   `bun run ci:typecheck`.
7. **Running out of memory.** The web `typecheck` (vue-tsc) peaks at about
   4.4 GB, and its script allows an 8 GB heap. The API `tsc` and full vitest
   suites are in the same class. Count what else is running before starting
   one. On a 32 GB machine shared with other sessions, about three heavy checks
   at once is the limit. Pass `--maxWorkers` to full vitest runs, and judge a
   command by its exit code, never through `| tail`, which masks it.

## Testing

All packages use **vitest**, not bun's built-in test runner. Always run tests with:

```sh
# Per-package
cd apps/api && npx vitest run
cd apps/web && npx vitest run
cd packages/email-renderer && npx vitest run
cd packages/email-builder && npx vitest run

# All packages via turbo (cached — unchanged packages replay instantly)
bun run ci:test
```

Do **not** use `bun test` — it skips the vitest setup file that polyfills Nuxt auto-imports (`ref`, `computed`, etc.) and will produce false failures.

### Faster inner loop

`turbo test` is result-cached and dependency-aware (via the `transit` node in
`turbo.json`), so a change in `packages/shared` re-runs only the packages that
depend on it and everything else is a cache hit. Inside a single package, narrow
further with vitest's own change detection:

```sh
cd apps/api
npx vitest --changed              # only tests affected by uncommitted changes
npx vitest related path/to/file.ts  # only tests that import the given file
```

CI mirrors this: pull requests run only the workspaces Turborepo reports as
affected (`scripts/ci-select-affected.sh`); pushes, the nightly schedule and
manual dispatch run the full matrix as a safety valve. Small suites share four
bounded jobs; web/API coverage uses three/four identified shards and merged
threshold checks. Releases reuse full main CI only for the exact commit and
verified run/attempt evidence, or invoke the same full graph as a fallback.

## Verifying

The proof a change needs depends on what it changes:

- **Logic, data, state, auth and protocol bugs** get a failing test first: the
  fewest tests that fail on `main` for that reason, in the module's existing
  test file. Then the fix. The PR says the test failed before the fix.
- **Purely visual bugs** (spacing, colour, alignment, a layout shift) get
  before/after screenshots as their proof (see [Pull requests](#pull-requests))
  and no test. Don't add a UI test for a nitpick, and don't ask for one in
  review when a capture already shows the fix.
- **Backend behaviour with no visible surface** ships focused tests for that
  behaviour, plus the command output when a run shows something a test can't.

Tests are deterministic. **A test that needs a timeout to pass is wrong.**

- Don't sleep on the real clock (`setTimeout` in a promise, `timers/promises`,
  a `sleep`/`delay` helper). Await the thing that marks the milestone: the
  promise, the emitted event, the socket's `data` or `close` event, the drained
  queue. Timer logic runs under `vi.useFakeTimers()` and
  `vi.advanceTimersByTimeAsync()`. Protocol fixtures that need real sockets
  (MTA, IMAP, SMTP, mail-sync) still await a socket event, not a delay.
- Don't measure elapsed time. No `performance.now()`, and no `Date.now()`
  stored and subtracted later; assert on events and counts. Fixture timestamps
  such as `createdAt: Date.now()` are fine, and time-dependent logic pins the
  clock with `vi.setSystemTime()`.
- Scaling tests count work (loop iterations, regex calls, queries) and assert
  that it grows linearly with input size. Wall-clock ratios belong in
  `bun run perf:bench`, outside CI's test step.
- No polling loops (`while (!done) await tick()`, deadline loops). Await the
  event itself; for a DOM update, `await nextTick()` or `vi.waitFor()`.
- No numeric per-test timeouts. A suite with a large fixed setup cost takes its
  budget from the shared constants in `vitest.timeouts.ts`. Don't add `retry`
  to a config or a test: flaky tests are fixed, not retried.
- `it.skip` and `it.todo` need a tracking issue on the line above:
  `// quarantine: #1234 <why>`. `skipIf`/`runIf` on an environment condition
  (a missing binary, a platform) need no comment.

These points are the policy behind the `owlat/` test lint rules. If one fires,
this section is the reason. `owlat/no-real-time-wait-in-tests` flags sleeps,
`owlat/no-wall-clock-in-tests` elapsed-time measurement,
`owlat/no-polling-loop-in-tests` polling loops, and
`owlat/no-test-timeout-or-unreasoned-skip` per-test timeouts and skips without a
quarantine comment. A rule that `oxlintrc.json` does not enable yet does not
make its practice optional.

## Convex backend

File layout, naming, and permission rules for `apps/api/convex/` are documented
in [`apps/api/convex/CONVENTIONS.md`](apps/api/convex/CONVENTIONS.md). Read it
before adding new files, splitting existing ones, or touching mutation auth.

Environment variables in the Convex backend must go through `lib/env.ts` —
direct `process.env.*` reads outside that module are blocked by
`bun run --cwd apps/api lint:env` (part of that workspace's `lint` script).

## Hit every surface

The most common review finding here is a change that works on the path you
tested and is missing everywhere else. Before calling work done, walk this list
and name the entries that applied under "Surfaces touched" in the PR:

- **Entry points.** A behaviour reachable from a page is usually also reachable
  from the command palette (`apps/web/app/lib/commandPaletteRegistry.ts`), a
  keyboard shortcut (`apps/web/app/utils/shortcutCatalog.ts`) and settings.
  Fixing one entry point is not fixing the feature.
- **Web and desktop.** The desktop app (Tauri) ships the web app as a static
  SPA (`generate:desktop`, so no Nitro server routes) and reaches Rust through
  `invoke()`. Command names must match
  `apps/desktop/src-tauri/src/ipc_commands.rs` (`bun run lint:desktop-invoke`).
- **Convex.** Every public function goes through a builder in
  `lib/authedFunctions.ts` with the right floor; a feature behind a flag uses
  the `featureGated` builders; a data backfill is a ledger migration listed in
  `migrations/manifest.ts`; recurring work is registered in `crons.ts`. See
  [`CONVENTIONS.md`](apps/api/convex/CONVENTIONS.md).
- **Services.** `apps/mta`, `apps/imap`, `apps/mail-sync`, `apps/code-worker`,
  `apps/updater` and `apps/decision-local` run as their own processes and
  Docker images. A change to a shared package they import (`packages/shared`,
  `mail-message`, `smtp-*`, `mta-protocol`) reaches them. A new import of
  another workspace package must also be copied in by every Dockerfile that
  builds a consumer, `apps/web/Dockerfile` included. `lint:deploy-closure`
  checks the convex-deploy image; the **Docker Build** CI job catches the rest.
- **Copy and docs.** UI strings go into both `apps/web/i18n/locales/en.json`
  and `de.json` (German copy uses informal, lowercase "du"). Check whether the
  change makes `apps/docs/content/en` or `de` inaccurate.
- **Self-hosting.** A new environment variable is read through `lib/env.ts` in
  the backend, documented in `.env.selfhost.example` (and in `SECURITY.md` when
  it is a secret), and offered by `apps/setup-cli` when an operator has to
  choose it.
- **Kits and SDKs.** What plugins and send-provider bundles see is defined in
  `packages/plugin-kit` and `packages/provider-kit`; a change to the public
  HTTP API reaches `packages/sdk-js` and `packages/sdk-java`.
- **Mailbox scope.** `mailboxes.scope` is the only record of whether a mailbox
  is personal or a team inbox, and it decides who sees it and who may act on
  it. A mail feature needs an answer for both kinds.
- **AI agent tools.** A capability a user can trigger is often one the
  assistant should reach through a tool in `assistant/toolRegistry.ts` (with
  its feature flag, data scope and spend tag). Decide, even if the decision is
  "not exposed".
- **Reverse states.** If you added a way in, add the way out and a way to see
  the current state. Snooze needs unsnooze, archive needs restore, hide needs a
  place to unhide. A one-way door is a bug.

## Design decisions

There are no ADRs; the series was removed in October 2026. Put the reason for a
decision where the next maintainer would get it wrong: a comment next to the
code it constrains, or a rule in `apps/api/convex/CONVENTIONS.md` when it spans
modules. Comments state the constraint, not its history or an issue number. The
PR description records why the change was made. Don't add a numbered decision
record or a new decisions folder. To read a removed record, use
`git log --diff-filter=D --name-only -- docs/adr` and `git show <sha>^:<path>`.

## Pull requests

Titles and commit subjects are conventional and in plain language:
`fix(web): the reader keeps its scroll position after a reply`. The body
follows [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md):
problem, change, the surfaces touched (see
[Hit every surface](#hit-every-surface)), and verification: what you ran, what
you saw, and what you couldn't check. Types and scopes are listed in
[`CONTRIBUTING.md`](CONTRIBUTING.md#commit-messages).

**A PR that changes the UI must include before/after screenshots in its
description.** "Changes the UI" means any edit that alters what a user sees:
a `.vue` file under `apps/web/app/` or `apps/marketing/`, a component's copy,
a layout, a token or a palette class. Post one pair per affected surface — the
same page/viewport/theme in both shots, so the diff is the change and nothing
else.

The backend cannot be booted locally (Convex bundling fails on this tree), so
captures come from a dev-only screenshot harness that renders the real
authenticated UI against a mocked Convex client and mocked better-auth
endpoints. The harness is intentionally kept out of the repository — it is
scaffolding, not product — so none of it may ever be committed.

Capture the "before" shots _before_ you start editing: once the change is in
the working tree the original state is gone.

If it makes sense, feel free to also include video of the changes.

## Issues

If you find things along the way that can be improved, feel free to fan out a sub agent that investigates the issue and then optionally creates an issue on GitHub. If it is a real issue.

## Personal Info

Please make sure to not include personal information in PRs or commits. So for example, private IP addresses or domains should not be included. Use general Owlat addresses.
