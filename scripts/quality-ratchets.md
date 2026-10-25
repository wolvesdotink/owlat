# Quality ratchets

`bun run lint:warnings` is part of the shared CI/release lint gate. It runs
oxlint with `--deny-warnings` and compares diagnostics against the frozen
`lint-warning-baseline.json`. The key is the file, rule, message, and offending
source token, with an exact count. Moving a line does not add an exception;
a new warning, a changed offending token, or an increased count fails. Like every
`scripts/ratchet.sh` baseline, the comparison is strict in both directions: a
count that drops below its baseline, or a key with no live warnings left, fails
as stale until the entry is lowered or deleted, so a fixed warning cannot come
back unnoticed. Existing errors always fail, as do tool crashes or invalid
output. Do not regenerate the baseline to accept new warnings.

`import/no-cycle` is an error by default. The initial 17 cycle diagnostics are
limited to the file patterns at the end of `oxlintrc.json`; these remain warnings
so existing workspace lint commands can run. They are still covered by the warning
ratchet. Remove a file's exception when its last cycle is fixed. Patterns are
relative to either the repository or workspace lint directory; the baseline
retains exact repository paths.

Owlat's own oxlint rules live in `packages/oxlint-plugin-owlat` and load through
`jsPlugins` in `oxlintrc.json`, so every workspace lint runs them. A rule with no
remaining offenders is an error there. A rule that lands with debt is a warning
instead, and `bun run lint:owlat` (`scripts/check-owlat-lint.sh`) owns it: the
findings are compared through `scripts/ratchet.sh` against
`scripts/owlat-lint-baseline.txt`, so a new finding fails and a fixed one must be
deleted from the baseline. The lint warning ratchet above skips owlat warnings,
so each finding has one baseline. `oxlintrc.json` also reports unused disable
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
