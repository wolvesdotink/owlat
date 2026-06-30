# Claude Code Instructions

## Testing

All packages use **vitest**, not bun's built-in test runner. Always run tests with:

```sh
# Per-package
cd apps/api && npx vitest run
cd apps/web && npx vitest run
cd packages/email-renderer && npx vitest run
cd packages/email-builder && npx vitest run

# All packages via turbo
bun run ci:test
```

Do **not** use `bun test` — it skips the vitest setup file that polyfills Nuxt auto-imports (`ref`, `computed`, etc.) and will produce false failures.

## Convex backend

File layout, naming, and permission rules for `apps/api/convex/` are documented
in [`apps/api/convex/CONVENTIONS.md`](apps/api/convex/CONVENTIONS.md). Read it
before adding new files, splitting existing ones, or touching mutation auth.

Environment variables in the Convex backend must go through `lib/env.ts` —
direct `process.env.*` reads outside that module are blocked by
`bun run lint:env` (run as part of `bun run lint`).
