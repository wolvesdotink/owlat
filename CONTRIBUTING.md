# Contributing to Owlat

Thanks for your interest in contributing to Owlat! This guide covers the essentials to get you up and running.

## Development Setup

You need Bun and Docker (Compose v2). From a fresh checkout or worktree:

```bash
bun run setup:worktree   # frozen install, env links, builds the web app's workspace deps
bun run dev:stack        # local Convex + Redis, push, demo seed, Convex watcher + Nuxt
```

`dev:stack` gives every checkout its own containers, data and ports, prints
the URL to open, and seeds `dev@example.com` / `devpassword12345`. Stop it with
Ctrl-C, then `bun run dev:stack down` (add `--volumes` to delete its data).
[`docs/operations/development.md`](./docs/operations/development.md) is the
runbook: ports and `OWLAT_PORT_OFFSET`, state, seeding, stopping what you
started. [`docs/operations/observability.md`](./docs/operations/observability.md)
covers logs, metrics and following a send. The
[Developer Guide](https://docs.owlat.app/developer/) explains the architecture.

### Developing on Windows

The toolchain itself — Bun, Nuxt, Convex, the Tauri CLI, and vitest — is
cross-platform and runs natively on Windows. The catch is the repo's lint and CI
gates: `bun run lint` and `bun run ci:verify` shell out to bash scripts under
`scripts/` and `apps/*/scripts/`, several of which use bash process substitution
(`<(…)`) and coreutils. Native PowerShell/cmd cannot run those, so develop
inside **WSL2** (recommended) or **Git Bash**.

`.gitattributes` forces `LF` line endings, so the shell scripts are checked out
without CRLF mangling regardless of your Git `core.autocrlf` setting. Run the
desktop app from the same WSL2 or Git Bash shell too: the Tauri hooks in
`apps/desktop/src-tauri/tauri.conf.json` (and the `generate:desktop` script they
call) prefix commands with POSIX-style env vars like `OWLAT_DESKTOP=true …`,
which native PowerShell/cmd cannot parse. macOS and Linux need no special setup.

### Format on commit

CI's format gate (`bun run lint:format`) fails when a changed JS/TS file is not
oxfmt-clean. To fix that before it reaches CI, install the pre-commit hook once
per clone:

```bash
bun run hooks:install     # every worktree of this clone shares the hook
bun run hooks:uninstall   # remove it again
```

On each commit the hook runs oxfmt (`oxfmtrc.json`) over the staged `.ts`,
`.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` files, the set the CI gate checks, and
stages the result. Only the staged content is formatted: unstaged edits and
untracked files are left as they are, and a partially staged file keeps its
unstaged changes. If oxfmt cannot parse a staged file, the commit stops and
nothing is changed. `git commit --no-verify` skips the hook, and
`bun run format:staged` runs the same formatter by hand. The installer leaves an
existing pre-commit hook, or a `core.hooksPath` setup, alone; call
`bun scripts/format-staged.ts` from that hook instead.

## Testing

All packages use **vitest**. Never use `bun test` — it skips the vitest setup file that polyfills Nuxt auto-imports and will produce false failures.

```bash
# Run tests for a single package
cd apps/api && npx vitest run
cd apps/web && npx vitest run
cd packages/email-renderer && npx vitest run
cd packages/email-builder && npx vitest run
cd packages/sdk-js && npx vitest run

# Run all tests via Turbo (result-cached; unchanged packages replay instantly)
bun run ci:test
```

The `ci:*` scripts run over every workspace except `desktop` (built by its own
Rust/Tauri workflow). They use a negative `--filter` so a newly-added package is
picked up automatically — there is no per-workspace list to keep in sync.

`turbo test` is dependency-aware via the `transit` node in `turbo.json`: a change
in `packages/shared` re-runs only the packages that depend on it, and everything
else replays from cache. Inside a single package, narrow further with vitest's
own change detection:

```bash
cd apps/api
npx vitest --changed              # only tests affected by uncommitted changes
npx vitest related path/to/file.ts  # only tests that import the given file
```

## Backend conventions

The Convex backend (`apps/api/convex/`) has its own file-layout, naming, and
permission rules — read
[`apps/api/convex/CONVENTIONS.md`](./apps/api/convex/CONVENTIONS.md) before
adding backend files or touching mutation auth. Extra lint gates run as part
of `bun run lint` and will fail CI, including:

- `lint:env` — all `process.env.*` reads must go through `convex/lib/env.ts`.
- `lint:patterns` — Convex best-practice ratchets (always declare `args:`,
  index don't filter, bound `.collect()`, no `console.log`).
- `lint:session-threading` — handlers on the org-scoped builders must use the
  session their auth floor already resolved instead of re-resolving it
  (frozen-baseline ratchet, `apps/api/scripts/check-session-threading.sh`).
- `lint:feature-floors` — handlers in a feature-gated family use its
  `featureGated` builder instead of an inline `assertFeatureEnabled`
  (ratchet with a justified-sites baseline,
  `apps/api/scripts/check-feature-floors.sh`).
- `lint:utc-day` — day starts and `YYYY-MM-DD` day keys come from
  `convex/lib/clock.ts`, never a hand-rolled `setUTCHours(0, 0, 0, 0)`,
  `toISOString().slice(0, 10)` or `.split('T')[0]`
  (`apps/api/scripts/check-utc-day.sh`).
- `lint:error-classifiers` — a backend failure is classified by its type
  (`InternalFailure` kind, Operation error category), never by matching its
  message text; only platform and external-provider wording is listed in the
  baseline (`apps/api/scripts/check-error-classifiers.sh`).
- `lint:html-to-text` (root, in `ci:lint`) — HTML-to-text for snippets,
  previews, prompts, search excerpts, scans and text/plain parts goes through
  `htmlToPlainText` from `@owlat/shared/html`, never a private
  `.replace(/<[^>]+>/g, …)` strip, across `apps/api/convex`,
  `packages/shared/src` and `packages/mail-message/src`
  (`scripts/check-html-to-text.sh`).
- `lint:crypto-primitives` (root, in `ci:lint`) — HMAC signing and
  constant-time comparison go through `apps/api/convex/lib/crypto.ts` (Convex),
  `@owlat/shared/constantTimeEqual` (Node services), and the MTA request
  signature through `@owlat/mta-protocol/signer`. Elsewhere under `apps/` or
  `packages/`, a Web Crypto HMAC `importKey`/`sign`/`verify`, an `importKey`
  whose algorithm is not a literal, any `timingSafeEqual` reference or an
  XOR-accumulate compare loop fails (`scripts/check-crypto-primitives.sh`). It
  is a pattern check: Node's `createHmac` and other spellings are not covered.
- `lint:stored-block-corpus` (root, in `ci:lint`) — against a pull request's
  base branch, the commit a push replaced, or (other CI runs) the default
  branch, failing in CI when that history cannot be resolved, no stored EditorBlock fixture or HTML snapshot in
  `packages/email-renderer/src/__tests__/storedBlocks/` is edited in place, a
  fixture goes only with its `contentBlockVersion` retired in `retired.json`,
  and a snapshot of the current renderer version goes only with its fixture or
  an `EMAIL_RENDERER_VERSION` bump (`scripts/check-stored-block-corpus.ts`).

The web app's `lint` script (`apps/web`) runs gates of its own, including:

- `lint:localized-text` — copy a pure module hands to a component is typed
  `LocalizedText` and rendered with `useLocalized()` (or `resolveLocalized`),
  both from `app/utils/localizedText.ts`, never a restated union or an inline
  `typeof v === 'string' ? t(v) : t(v.key, v.params ?? {})`
  (frozen-baseline ratchet, `apps/web/scripts/check-localized-text.sh`).

## Code Quality

Run these before submitting a PR:

```bash
bun run typecheck    # TypeScript checking across all packages
bun run lint         # Oxlint
bun run lint:format  # oxfmt check of the JS/TS files your branch changes
```

Format only the files you changed, with the repository's config:

```bash
./node_modules/.bin/oxfmt --config oxfmtrc.json <paths>
```

Avoid `bun run ox:fmt` before a commit: the repository predates its formatter
config, so a whole-tree run rewrites several hundred files the change never
touched. Bare `npx oxfmt` / `bunx oxfmt` ignore `oxfmtrc.json` or fetch a
different version. `bun run ci:lint` does not typecheck, so run
`bun run typecheck` (or `bun run ci:typecheck`) as well.

For a quick pre-push pass over just your change, run:

```bash
bun run check:changed          # against the merge base with origin/main
bun run check:changed <ref>    # against the merge base with <ref>
```

It checks the formatting of the changed files and lints them, runs `turbo lint`
and `turbo typecheck` for the affected workspaces, the root `lint:*` gates whose
inputs changed (`scripts/ci/gates.ts`), the plugin smokes when the backend or a
plugin package is affected, and the tests related to the changed files. Its
summary lists what CI still runs on top. Add `-- --dry-run` to see the plan
without running it.

Or run everything CI checks at once:

```bash
bun run ci:verify   # scripts/ci-gate.sh verify: lint gates + typecheck + tests
bun run test:ramp   # the ramp-gate matrix, both legs (see "CI checks")
```

### Dead-code gate

A frozen-baseline ratchet keeps orphaned exports, files, and modules from
accreting silently (the repo has a documented history of speculative seams and
zero-caller modules). Run it before submitting a PR:

```bash
bun run lint:deadcode   # == bash scripts/check-dead-code.sh
```

It runs [`knip`](https://knip.dev) (config: `knip.jsonc`) restricted to
dead-_code_ issue types (unused files / exports / types / members), normalises
the result to a sorted list, and compares it against
`scripts/dead-code-baseline.txt`. The ratchet is strict in both directions, like
`apps/api/scripts/check-query-authz.sh`: a **new** orphan that is not in the
baseline fails, and a **stale** baseline entry that is no longer dead fails
(delete the line so the debt only ever goes down). Do not add new lines to the
baseline — fix or intentionally re-anchor the export instead. The dependency /
unlisted / unresolved knip categories are deliberately excluded (knip does not
model bun catalogs, Nuxt aliases, or transitive deps, so they are noise here).

Each library package's `entry` in `knip.jsonc` is its **public surface only**
(the package.json `exports` barrels plus its test files), not the whole `src/`
tree — so a zero-importer module or unused export anywhere under `src/` is
reported, which is the exact failure mode the gate exists to catch. If you add a
new public subpath export to a package, add the corresponding barrel to that
package's `entry` list.

`ci:lint` and `ci:verify` both run `scripts/ci-gate.sh`, which runs this gate
after the turbo lint pass, so a PR that introduces a new orphan fails CI just
like the other ratchets. Because the hosted GitHub Actions **Lint & Typecheck**
job runs `bun run ci:lint`, the gate is enforced on every PR there — the same
path that runs `apps/api/scripts/check-query-authz.sh` — not only when someone
runs `ci:verify` locally.

### Writing a baseline ratchet

Eight gates share one comparison. A check script owns a _generator_ — the walk
that prints today's violation set, one entry per line — and hands the rest to
`scripts/ratchet.sh`, which compares that set against the frozen baseline,
strict in both directions, and prints the wording the check passes in as flags:

```bash
exec scripts/ratchet.sh \
	--baseline scripts/<name>-baseline.txt \
	--ok "no new <thing>" \
	--new-header "FAIL: {n} new <thing>(s) not in {baseline}:" \
	--new-advice "How to fix one." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (<thing> fixed):" \
	"$@" \
	-- bash "$self" --generate
```

Every such gate therefore accepts `--write-baseline` to reseed itself, ignores
blank lines and `#` comments in a baseline, and never depends on the baseline
file's own sort order. Duplicate entries are significant, so a generator that
wants them collapsed sorts with `sort -u` itself. The runner's own tests are in
`scripts/__tests__/ratchet.test.ts`; the unit tests for all the gate scripts
run in one pass with `bun run lint:script-tests`.

## Pull Request Process

### Branch Naming

Use descriptive branch names with a prefix:

- `feat/` — new features
- `fix/` — bug fixes
- `refactor/` — code restructuring
- `docs/` — documentation changes
- `chore/` — tooling, dependencies, CI

### Commit Messages

Commit subjects and PR titles use [Conventional Commits](https://www.conventionalcommits.org/)
with a plain-language summary that says what changes for the reader:

```
type(scope): plain language
```

```
fix(web): show a failed share review instead of loading forever
feat(api): let a team inbox hold drafts until a gap is answered
test(mta): await the socket close instead of sleeping
```

- Types: `fix`, `feat`, `test`, `perf`, `refactor`, `docs`, `chore`,
  `ci`, `build`, `style`.
- Scopes name the workspace or area. The ones in use are `api`, `web`,
  `ui`, `postbox`, `inbox`, `mta`, `imap`, `mail-sync`, `shared`,
  `email-builder`, `email-renderer`, `mail-message`, `smtp-listener`,
  `desktop`, `setup-cli`, `updater`, `webhooks`, `ai`, `docs`, `ci`,
  `scripts`, `deps` and `release`. Pick the narrowest one that fits. A change
  that spans two areas can name both (`fix(api,web): ...`), but that is rare.
- Keep the subject in lowercase after the colon and without a trailing period.
  Add a body for anything the subject cannot carry: the reason, a constraint,
  what was deliberately left out.

### Pull request description

`.github/PULL_REQUEST_TEMPLATE.md` asks for the problem, the change, the
**surfaces touched** and the **verification**. For surfaces, walk the
[Hit every surface](./CLAUDE.md#hit-every-surface) checklist and name what
applied. For verification, state what you ran, what you saw and what you
couldn't check; the proof each kind of change needs is described under
[Verifying](./CLAUDE.md#verifying). A UI change includes before/after
screenshots, uploaded to the PR description rather than committed
(`lint:no-pr-assets` fails on captures under `docs/`).

### CI checks

Pull requests against `main`, `integration/**` and `ux/**` run these
workflows; pushes to `main` and `integration/**`, the nightly schedule and
manual dispatch run the full set as a safety valve.

- **test.yml** (`CI`)
  - **Detect affected.** Asks Turborepo which workspaces the PR affects
    (`scripts/ci-select-affected.sh`) and feeds the matrices below. Every
    non-PR run selects everything.
  - **Test group (1–4).** Duration-weighted groups run the small affected
    workspaces with bounded Turbo/Vitest concurrency. MTA retains its own
    runner and required Redis integration tests.
  - **Test api (shard 1–4/4)** and **Test web (shard 1–3/3)**, each followed
    by **merge + coverage**. Shards collect coverage without any global or
    per-path floor; the merge validates every report's commit, run, attempt
    and shard identity, then enforces all original thresholds. Successful
    reports from earlier attempts of the same run survive partial reruns.
  - **Ramp gates (reference_arm | standalone).** The ramp-controller gate
    suite twice: once equipped, once as a deployment with zero third-party
    accounts. Never affected-filtered. Locally: `bun run test:ramp` runs both
    legs, `bun run test:ramp standalone` one.
  - **Lint** and **Typecheck**, on separate runners. `bun run ci:lint` (`scripts/ci-gate.sh lint`: the
    plugin codegen and Convex bundle smokes, `turbo lint`, then every
    `lint:*` ratchet and repo gate in the order that script lists them) and
    `bun run ci:typecheck`.
  - **Docker Build (<image>).** Builds each affected image listed in
    `.github/docker-images.json`; images marked `runtimeSmoke` also get their
    packaged Node entry imported once.
  - **Test (packages/sdk-java).** Maven `verify`, when `packages/sdk-java`
    changes.
  - **Desktop SPA (build + inspect).** Builds the real `generate:desktop`
    bundle the desktop app packages and fails on a referenced chunk,
    stylesheet, font, icon or app manifest that was not emitted or does not
    match its integrity hash (`scripts/check-desktop-spa.ts`). When web is
    affected, when the desktop bridge or Tauri config changes, and on full
    runs. The bridge's `invoke()` names are checked against `ipc_commands.rs`
    in **Lint** (`lint:desktop-invoke`).
  - **Test Summary.** The single required status check; point branch
    protection at it. Selected jobs must succeed; unselected jobs must be
    skipped. Missing reports, selected skips, failures and cancellations fail
    closed. Full runs upload identified verification evidence for release reuse.
- **security.yml** (`Security`). **Dependency audit** (`bun audit`; fails on
  High/Critical through `scripts/check-security-audit.ts`), **SAST (Semgrep)**
  and **Secret scan (gitleaks)** over the full history. Also nightly.
- **desktop-ci.yml** (`Desktop CI`). **Rust build + tests** on Ubuntu, macOS
  and Windows, including the TS-bridge lint, typecheck and tests. Only when
  `apps/desktop/**`, `bun.lock` or `package.json` change.
- **dependabot-lockfile.yml**. On Dependabot's own PRs, regenerates `bun.lock`
  and pushes it back (needs `DEPENDABOT_LOCKFILE_PAT`, see below).

Out of band:

- **e2e.yml** (`E2E`). Playwright against a test deployment; nightly, on
  pushes to `main` that touch `apps/web/**`, `apps/api/**` or `packages/**`,
  and on dispatch. Fails when the `CONVEX_TEST_*` secrets are unset rather than
  reporting green. The job owns that deployment for the length of a run: it
  wipes the data (`POST /dev/reset`) and pushes the commit's functions before
  driving the browser, so nothing on it survives a run and two runs must never
  overlap. The deployment therefore needs `OWLAT_DEV_MODE` enabled and its
  `INSTANCE_SECRET` equal to `CONVEX_TEST_INSTANCE_SECRET`. The reset spares the
  non-tenant tables (`convex/lib/tenantTables.ts` — `keyVault`, `warmingState`,
  `providerHealth`, …), so a breaking schema change to one of those needs the
  deployment's volume recreated by hand before the next run can push.
- **release.yml**, **server-release.yml**, **desktop-release.yml**.
  Tag-triggered. Each starts with `_verify.yml`, which reuses successful full
  main CI for the exact commit or calls the full CI graph as a fallback.
  Main pushes use per-commit concurrency groups; PR updates still cancel stale
  work. See `docs/RELEASING.md` for evidence rules, cache producers, stable alias
  reconciliation and post-publication update checks.

For timing and cache baselines, run `bun run ci:report` with read-only GitHub
access. Compare matched change categories and include queue and retry delays.

All checks must pass before merging. To reproduce the PR gate locally, run
`bun run ci:verify` and `bun run test:ramp`.

Bun itself is installed by `.github/actions/setup-bun`, which reads the version
from `packageManager` in the root `package.json`; bump it there only.

### CI secrets

Every secret the workflows reference, in one place. `GITHUB_TOKEN` is provided
by Actions and is not listed.

| Secret                                                                      | Used by                                                                                                                       | When unset                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CONVEX_TEST_URL`, `CONVEX_TEST_SITE_URL`                                   | e2e.yml, as `NUXT_PUBLIC_CONVEX_URL` / `NUXT_PUBLIC_CONVEX_SITE_URL` of a dedicated test deployment                           | the E2E job fails with an error naming the missing secret                         |
| `CONVEX_TEST_ADMIN_KEY`                                                     | e2e.yml, to push the commit under test's functions to that deployment before the suite runs                                   | the E2E job fails with an error naming the missing secret                         |
| `CONVEX_TEST_INSTANCE_SECRET`                                               | e2e.yml, to call `POST /dev/reset` on that deployment (needs `OWLAT_DEV_MODE` set on it)                                      | the E2E job fails with an error naming the missing secret                         |
| `DEPENDABOT_LOCKFILE_PAT`                                                   | dependabot-lockfile.yml; a fine-grained PAT (Contents: read & write) stored as a **Dependabot** secret, not an Actions secret | the job warns and skips; Dependabot PRs then fail `bun install --frozen-lockfile` |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`           | _desktop-build.yml, updater bundle signing                                                                                    | unsigned artifacts with a `::warning::`                                           |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | _desktop-build.yml, macOS code signing                                                                                        | unsigned artifacts                                                                |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`                               | _desktop-build.yml, macOS notarization                                                                                        | unsigned artifacts                                                                |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`                       | _desktop-build.yml, Windows Authenticode                                                                                      | unsigned artifacts                                                                |

Setup steps for the desktop signing secrets are in `apps/desktop/README.md`.

## Package Guidelines

### When to Create a New Package

Create a new package in `packages/` when:

- The code is shared across multiple apps (e.g., `shared`, `email-renderer`)
- It represents an independently publishable library (e.g., `sdk-js`)
- It has a distinct responsibility boundary (e.g., `email-builder` is a Vue component library)

Otherwise, extend an existing package. Most backend logic belongs in `apps/api/convex/`, and most UI code belongs in `apps/web/` or `packages/ui/`.

### Workspace Conventions

- Package names use the `@owlat/` scope (e.g., `@owlat/email-renderer`)
- Each package has its own `tsconfig.json` and `vitest.config.ts` (if tested). Build the config's coverage block with `packageCoverage` from the root `vitest.shared.ts` (or the whole config with `nodePackageConfig` for a plain node package), and take a longer time budget only from `vitest.timeouts.ts`
- Use Bun workspaces for cross-package dependencies (`"@owlat/shared": "workspace:*"`)

## File Naming Conventions

- Vue components: `PascalCase.vue`
- Composables: `useCamelCase.ts`
- Convex functions: `camelCase.ts`
- Pages: `kebab-case.vue` or `[param].vue`

See the [Developer Guide](https://docs.owlat.app/developer/) for more on patterns and conventions.

## Design decisions

Owlat does not keep architecture decision records. Explain a decision where a maintainer would trip over it: a short comment next to the code it constrains, or a rule in [`apps/api/convex/CONVENTIONS.md`](./apps/api/convex/CONVENTIONS.md) when it spans several modules. The pull request description is the record of why a change was made.
