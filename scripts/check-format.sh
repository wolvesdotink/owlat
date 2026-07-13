#!/usr/bin/env bash
#
# Format gate (oxfmt). oxfmtrc.json and the `ox:fmt:check` script exist but
# nothing ever ran them, so the committed formatter config was dead and
# formatting drifted with green CI. We deliberately do NOT check the whole
# tree here: the repo predates the oxfmt config, so a full-tree `--check`
# would be pure noise and fail every build. Instead this ratchets — every
# JS/TS file a change touches must be oxfmt-clean, so drift only ever shrinks.
#
# Run the whole-tree formatter/check via `bun run ox:fmt` / `bun run ox:fmt:check`.
set -euo pipefail

cd "$(dirname "$0")/.."

# Determine the base ref to diff against.
if [ -n "${GITHUB_BASE_REF:-}" ]; then
	# Pull request: compare against the target branch.
	git fetch --quiet --depth=1 origin "$GITHUB_BASE_REF" 2>/dev/null || true
	base="origin/$GITHUB_BASE_REF"
elif [ -n "${OXFMT_BASE:-}" ]; then
	base="$OXFMT_BASE"
elif git rev-parse --verify --quiet origin/main >/dev/null; then
	base="origin/main"
else
	base="HEAD~1"
fi

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
	echo "check-format: base ref '$base' not found; skipping."
	exit 0
fi

mergebase="$(git merge-base "$base" HEAD 2>/dev/null || echo "$base")"

files=()
# Exclude Convex-generated code: `convex codegen` emits double-quoted import
# paths that scripts/check-codegen.sh greps for verbatim, so oxfmt's single-quote
# rule must never touch `_generated/`. Generated files are owned by codegen, not
# the formatter. Keep this comment outside the process substitution: Bash 3.2
# misparses backticks inside comments nested in `< <(...)`.
while IFS= read -r f; do
	[ -n "$f" ] && [ -f "$f" ] && files+=("$f")
done < <(
	git diff --name-only --diff-filter=ACMR "$mergebase"...HEAD -- \
		'*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' \
		':(exclude)**/_generated/**'
)

if [ "${#files[@]}" -eq 0 ]; then
	echo "check-format: no changed JS/TS files to check."
	exit 0
fi

echo "check-format: checking ${#files[@]} changed file(s) with oxfmt..."
exec ./node_modules/.bin/oxfmt --config oxfmtrc.json --check "${files[@]}"
