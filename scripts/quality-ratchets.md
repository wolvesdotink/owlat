# Quality ratchets

`bun run lint:warnings` is part of the shared CI/release lint gate. It runs
oxlint with `--deny-warnings` and compares diagnostics against the frozen
`lint-warning-baseline.json`. The key is the file, rule, message, and offending
source token, with a maximum count. Moving a line does not add an exception;
a new warning, a changed offending token, or an increased count fails. Existing
errors always fail, as do tool crashes or invalid output. Remove baseline entries
as warnings are fixed; do not regenerate the baseline to accept new warnings.

`import/no-cycle` is an error by default. The initial 17 cycle diagnostics are
limited to the file patterns at the end of `oxlintrc.json`; these remain warnings
so existing workspace lint commands can run. They are still covered by the warning
ratchet. Remove a file's exception when its last cycle is fixed. Patterns are
relative to either the repository or workspace lint directory; the baseline
retains exact repository paths.

Coverage thresholds live in each workspace's Vitest configuration. The September
2026 baseline measures all configured source files, including untouched modules.
New coverage blocks cover the plugin workspaces and UI components/composables.
Thresholds use the measured whole percentage (less than one point of rounding
headroom). Raise them as coverage improves; do not lower them to make new code pass.
Run `bun run ci:test:coverage` to enforce them. Coverage reports are generated
artifacts and must not be committed.
