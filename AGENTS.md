# Owlat — agent guide

This file intentionally defers to the canonical sources rather than restating
them (an earlier standalone copy here had drifted out of sync with the code).

- **Working instructions** (testing, Convex backend rules, env access) —
  [`CLAUDE.md`](./CLAUDE.md).
- **Convex file layout, naming, and permission rules** —
  [`apps/api/convex/CONVENTIONS.md`](./apps/api/convex/CONVENTIONS.md). Read it
  before adding/splitting backend files or touching mutation auth.
- **Domain vocabulary** (the project's sharpened terms — Block, Send lifecycle,
  Reputation window, etc.) — [`CONTEXT.md`](./CONTEXT.md), kept in sync with the
  ADRs in [`docs/adr/`](./docs/adr/).
- **Design tokens** ("Warm Minimal" palette, typography, component classes) live
  in code: [`apps/web/app/assets/css/main.css`](./apps/web/app/assets/css/main.css)
  is the single source of truth.
- **Product / API / developer docs** — the Nuxt Content site under
  [`apps/docs/content/`](./apps/docs/content/).
