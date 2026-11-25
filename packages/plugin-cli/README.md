# @owlat/plugin-cli

The `owlat-plugins` CLI for managing the bundled Owlat plugin set.

It operates on the checked-in `plugins.config.ts` composition point and reuses
the deterministic PP-03 codegen (`@owlat/plugin-codegen`) — it never
re-implements composition. Every config edit is deterministic and idempotent,
packages are validated before anything is written, and a failed edit rolls back
cleanly. The CLI never evaluates `plugins.config.ts` as code and never imports an
arbitrary path: the only module loading it performs is delegated to the codegen's
verified loader, which imports exclusively the lockfile-pinned, provenance-checked
manifest entry of each bundled package (never a contribution or component module).

## Commands

```sh
bun run owlat-plugins create <plugin-id> [--name <package>] [--dir <path>] [--dry-run]
bun run owlat-plugins add <package> [--dry-run]
bun run owlat-plugins remove <package> [--dry-run]
bun run owlat-plugins codegen [--check] [--boundaries-only]
bun run owlat-plugins dev
```

- **create** — scaffold a new plugin package (files only; never installs or runs code).
  Inside the checkout it is a workspace member; a `--dir` outside it gets a
  self-contained package that installs `@owlat/plugin-kit` from npm.
- **add** / **remove** — edit `plugins.config.ts` and preview the capability diff
  the change would produce. `--dry-run` shows the diff and the proposed file
  without writing.
- **codegen** — regenerate (or `--check`) the bundled composition via the PP-03 codegen.
- **dev** — regenerate the composition and re-run on every `plugins.config.ts` change.

Run any command from anywhere inside an Owlat checkout: `bun run` finds the
`owlat-plugins` binary in the checkout's `node_modules/.bin`.
