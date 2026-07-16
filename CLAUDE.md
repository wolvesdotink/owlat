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
`bun run lint:env` (run as part of `bun run lint`).
