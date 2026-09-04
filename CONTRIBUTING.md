# Contributing to Owlat

Thanks for your interest in contributing to Owlat! This guide covers the essentials to get you up and running.

## Development Setup

See the [Developer Guide](https://docs.owlat.app/developer/) for full setup instructions. The short version:

```bash
bun install
cp .env.example .env   # local dev against a hosted Convex deployment
bun run dev:api        # Convex backend — the first run provisions the deployment
bun run dev            # Nuxt frontend
```

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

## Code Quality

Run these before submitting a PR:

```bash
bun run typecheck  # TypeScript checking across all packages
bun run lint       # Oxlint
bun run ox:fmt     # Format with Oxfmt
```

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

## Pull Request Process

### Branch Naming

Use descriptive branch names with a prefix:

- `feat/` — new features
- `fix/` — bug fixes
- `refactor/` — code restructuring
- `docs/` — documentation changes
- `chore/` — tooling, dependencies, CI

### Commit Messages

Write clear, concise commit messages. Use imperative mood ("Add feature" not "Added feature"). A short summary on the first line is sufficient for most changes; add a body for complex ones.

### CI checks

Pull requests against `main`, `integration/**` and `ux/**` run these
workflows; pushes to `main` and `integration/**`, the nightly schedule and
manual dispatch run the full set as a safety valve.

- **test.yml** (`CI`)
  - **Detect affected.** Asks Turborepo which workspaces the PR affects
    (`scripts/ci-select-affected.sh`) and feeds the matrices below. Every
    non-PR run selects everything.
  - **Test (<package>).** `turbo run test:coverage` per affected workspace.
  - **Test api (shard 1-3/3)** and **Test api (merge + coverage).**
    `apps/api` sharded across three runners; the merge job enforces the
    coverage threshold.
  - **Ramp gates (reference_arm | standalone).** The ramp-controller gate
    suite twice: once equipped, once as a deployment with zero third-party
    accounts. Never affected-filtered. Locally: `bun run test:ramp` runs both
    legs, `bun run test:ramp standalone` one.
  - **Lint & Typecheck.** `bun run ci:lint` (`scripts/ci-gate.sh lint`: the
    plugin codegen and Convex bundle smokes, `turbo lint`, then every
    `lint:*` ratchet and repo gate in the order that script lists them) plus
    `bun run ci:typecheck`.
  - **Docker Build (<image>).** Builds each affected image listed in
    `.github/docker-images.json`; images marked `runtimeSmoke` also get their
    packaged Node entry imported once.
  - **Test (packages/sdk-java).** Maven `verify`, when `packages/sdk-java`
    changes.
  - **Test Summary.** The single required status check; point branch
    protection at it. Skipped matrix jobs count as passed; failures and
    cancellations do not.
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
  pushes to `main` that touch `apps/web/**`, and on dispatch. Fails when the
  `CONVEX_TEST_*` secrets are unset rather than reporting green.
- **release.yml**, **server-release.yml**, **desktop-release.yml**.
  Tag-triggered. Each starts with the shared `_verify.yml` job, which runs
  `bun run ci:verify` (`scripts/ci-gate.sh verify`: the lint gate plus
  `turbo typecheck test`) on the exact tagged commit. See `docs/RELEASING.md`.

All checks must pass before merging. To reproduce the PR gate locally, run
`bun run ci:verify` and `bun run test:ramp`.

Bun itself is installed by `.github/actions/setup-bun`, which reads the version
from `packageManager` in the root `package.json`; bump it there only.

### CI secrets

Every secret the workflows reference, in one place. `GITHUB_TOKEN` is provided
by Actions and is not listed.

| Secret | Used by | When unset |
| --- | --- | --- |
| `CONVEX_TEST_URL`, `CONVEX_TEST_SITE_URL` | e2e.yml, as `NUXT_PUBLIC_CONVEX_URL` / `NUXT_PUBLIC_CONVEX_SITE_URL` of a dedicated test deployment | the E2E job fails with an error naming the missing secret |
| `DEPENDABOT_LOCKFILE_PAT` | dependabot-lockfile.yml; a fine-grained PAT (Contents: read & write) stored as a **Dependabot** secret, not an Actions secret | the job warns and skips; Dependabot PRs then fail `bun install --frozen-lockfile` |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | _desktop-build.yml, updater bundle signing | unsigned artifacts with a `::warning::` |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | _desktop-build.yml, macOS code signing | unsigned artifacts |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | _desktop-build.yml, macOS notarization | unsigned artifacts |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | _desktop-build.yml, Windows Authenticode | unsigned artifacts |

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
- Each package has its own `tsconfig.json` and `vitest.config.ts` (if tested)
- Use Bun workspaces for cross-package dependencies (`"@owlat/shared": "workspace:*"`)

## File Naming Conventions

- Vue components: `PascalCase.vue`
- Composables: `useCamelCase.ts`
- Convex functions: `camelCase.ts`
- Pages: `kebab-case.vue` or `[param].vue`

See the [Developer Guide](https://docs.owlat.app/developer/) for more on patterns and conventions.

## Architectural Decisions

Major design decisions are documented as ADRs in [docs/adr/](./docs/adr/). If your contribution involves a significant architectural change, consider adding a new ADR.
