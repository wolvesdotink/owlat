# Owlat — agent guide

This file intentionally defers to the canonical sources rather than restating
them (an earlier standalone copy here had drifted out of sync with the code).

- **Working instructions** are in [`CLAUDE.md`](./CLAUDE.md). Read it first.
  It holds the ways to hurt yourself on a shared machine (killing by pattern, the
  updater on the host Docker daemon, whole-tree formatting, discarding other
  sessions' work, `/tmp`, typecheck and memory), testing and the proof each kind
  of change needs, the "Hit every surface" checklist, Convex backend rules, env
  access and pull request rules.
- **Convex file layout, naming, and permission rules** —
  [`apps/api/convex/CONVENTIONS.md`](./apps/api/convex/CONVENTIONS.md). Read it
  before adding/splitting backend files or touching mutation auth.
- **Domain vocabulary** (the project's sharpened terms — Block, Send lifecycle,
  Reputation window, etc.) — [`CONTEXT.md`](./CONTEXT.md).
- **Design decisions** — there is no ADR series. See "Design decisions" in
  [`CLAUDE.md`](./CLAUDE.md).
- **Design tokens** ("Warm Minimal" palette, typography, component classes) live
  in code: [`packages/ui/assets/css/tokens.css`](./packages/ui/assets/css/tokens.css)
  is the single source of truth.
- **Product / API / developer docs** — the Nuxt Content site under
  [`apps/docs/content/`](./apps/docs/content/).
