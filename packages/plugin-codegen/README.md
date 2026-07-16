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
- The checked-in Convex manifest composition, static component installer, and
  Nuxt composition files are generated together. Component subpaths must be
  exact condition-independent package exports; the generated installer gives
  every component an injective `plugin_<id>` namespace through `app.use`.
  `--check` detects missing or stale output without writing.
- Send transports and agent steps each generate an isolate-safe metadata catalog
  and a separate `'use node'` executable registry. Agent-step generation also
  rejects unknown or terminal anchors, duplicate kinds, insertion cycles, and
  lifecycle edges outside the host's restrict-only policy.
- Core source may not import configured plugin packages outside those generated
  files, including through Node/Bun loaders or repository aliases.
  `--boundaries-only` enforces that rule without importing plugin code.

Run `bun run plugins:codegen` after editing the config. Builds and CI run
`bun run plugins:check` so stale or invalid composition fails closed.
