# Quality ratchets

`bun run lint:warnings` is part of the shared CI/release lint gate. It runs
oxlint over every workspace with `--deny-warnings` and fails on any error and
on any warning; there is no warning baseline. The only warnings it leaves alone
are those of `owlat/*` rules, which the owlat ratchet below owns. Tool crashes,
an unexpected exit status and invalid output fail too, so a broken run never
reads as a clean one. Fix a new warning at its source; do not add a
warning-level override or a baseline to make one pass.

`import/no-cycle` is an error everywhere. Break a cycle by moving the shared
part into a leaf module both sides import, not by importing through a facade
that re-exports the other side (a re-export is an import edge too).

Owlat's own oxlint rules live in `packages/oxlint-plugin-owlat` and load through
`jsPlugins` in `oxlintrc.json`, so every workspace lint runs them. A rule with no
remaining offenders is an error there. A rule that lands with debt is a warning
instead, and `bun run lint:owlat` (`scripts/check-owlat-lint.sh`) owns it: the
findings are compared through `scripts/ratchet.sh` against
`scripts/owlat-lint-baseline.txt`, so a new finding fails and a fixed one must be
deleted from the baseline. The zero-warning gate above skips owlat warnings,
so each finding has one owner. `oxlintrc.json` also reports unused disable
directives as errors, and `owlat/require-suppression-reason` asks every
suppression to say why (`-- reason` or a comment on the line above).

Coverage thresholds live in each workspace's Vitest configuration, built with
`packageCoverage` (or `nodePackageConfig` for a plain node package) from the root
`vitest.shared.ts`, so a config states only its floor and its exclusions. The September
2026 baseline measures all configured source files, including untouched modules.
New coverage blocks cover the plugin workspaces and UI components/composables.
Thresholds use the lower measured whole percentage across local and CI runs
(MTA: 88.08% locally, 87.96% on CI) (less than one point of rounding
headroom). The desktop and setup-cli floors, added later from a single local
measurement with no CI figure to compare, sit two points under it (desktop never
runs in CI). Raise them as coverage improves; do not lower them to make new code pass.
Run `bun run ci:test:coverage` to enforce them. Coverage reports are generated
artifacts and must not be committed.
