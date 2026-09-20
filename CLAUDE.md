# Claude Code Instructions

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
manual dispatch run the full matrix as a safety valve.

## Convex backend

File layout, naming, and permission rules for `apps/api/convex/` are documented
in [`apps/api/convex/CONVENTIONS.md`](apps/api/convex/CONVENTIONS.md). Read it
before adding new files, splitting existing ones, or touching mutation auth.

Environment variables in the Convex backend must go through `lib/env.ts` —
direct `process.env.*` reads outside that module are blocked by
`bun run --cwd apps/api lint:env` (part of that workspace's `lint` script).

## Pull requests

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
