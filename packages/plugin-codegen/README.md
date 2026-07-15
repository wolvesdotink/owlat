# `@owlat/plugin-codegen`

This private build tool owns Owlat's single composition point for bundled plugins.

- `plugins.config.ts` is parsed as static data; it is never imported or evaluated.
- Entries must be safe, exact npm package names installed directly from the
  registry in root `dependencies` or `optionalDependencies`, with matching
  installed metadata, contained realpaths, and an integrity-pinned `bun.lock`
  entry.
- Installed packages are imported only during build-time composition. Their default
  manifests must have one condition-independent root export, are snapshotted and
  validated once with `@owlat/plugin-kit`, and are ordered by manifest id through
  `@owlat/plugin-host`.
- The checked-in Convex and Nuxt composition files are generated together. `--check`
  detects missing or stale output without writing.
- Core source may not import configured plugin packages outside those two generated
  files, including through Node/Bun loaders or repository aliases.
  `--boundaries-only` enforces that rule without importing plugin code.

Run `bun run plugins:codegen` after editing the config. Builds and CI run
`bun run plugins:check` so stale or invalid composition fails closed.
