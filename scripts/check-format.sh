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

has_commit() { git rev-parse --verify --quiet "$1^{commit}" >/dev/null; }

# Determine the base ref to diff against. Fetch only a base the checkout lacks,
# and never with --depth: a depth-limited fetch into a full clone records the
# fetched tip as a shallow root, so once the target branch moves, HEAD has no
# merge base with it for this gate and every later one in the job.
if [ -n "${GITHUB_BASE_REF:-}" ]; then
	# Pull request: compare against the target branch. CI passes the commit the
	# event names as PR_BASE_SHA, so a push to the target mid-job cannot move
	# the base.
	if [ -n "${PR_BASE_SHA:-}" ]; then
		base="$PR_BASE_SHA"
		has_commit "$base" || git fetch --quiet --no-tags origin "$base" 2>/dev/null || true
	else
		base="origin/$GITHUB_BASE_REF"
		has_commit "$base" ||
			git fetch --quiet --no-tags origin \
				"+refs/heads/$GITHUB_BASE_REF:refs/remotes/origin/$GITHUB_BASE_REF" 2>/dev/null || true
	fi
elif [ -n "${OXFMT_BASE:-}" ]; then
	base="$OXFMT_BASE"
elif git rev-parse --verify --quiet origin/main >/dev/null; then
	base="origin/main"
else
	base="HEAD~1"
fi

if ! has_commit "$base"; then
	if [ "${CI:-}" = true ]; then
		echo "check-format: base ref '$base' not found; fetch the history (fetch-depth: 0) or set OXFMT_BASE." >&2
		exit 1
	fi
	echo "check-format: base ref '$base' not found; skipping outside CI."
	exit 0
fi

# A shallow checkout may cut the history between HEAD and the base.
if ! mergebase="$(git merge-base "$base" HEAD 2>/dev/null)" &&
	[ "$(git rev-parse --is-shallow-repository)" = true ]; then
	git fetch --quiet --no-tags --unshallow origin 2>/dev/null || true
	mergebase="$(git merge-base "$base" HEAD 2>/dev/null)" || true
fi
if [ -z "$mergebase" ]; then
	# Without a merge base the diff below lists nothing and the gate would pass
	# unchecked.
	if [ "${CI:-}" = true ]; then
		echo "check-format: HEAD has no merge base with '$base'; fetch the history (fetch-depth: 0) or set OXFMT_BASE." >&2
		exit 1
	fi
	echo "check-format: HEAD has no merge base with '$base'; skipping outside CI."
	exit 0
fi

files=()
# Exclude Convex-generated code: `convex codegen` emits double-quoted import
# paths that scripts/check-codegen.sh greps for verbatim, so oxfmt's single-quote
# rule must never touch `_generated/`. Generated files are owned by codegen, not
# the formatter. Keep this comment outside the process substitution: Bash 3.2
# misparses backticks inside comments nested in `< <(...)`.
pathspecs=(
	'*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs'
	':(exclude)**/_generated/**'
)
# NUL-delimited end to end: without -z, Git quotes a path holding a tab,
# quote or non-ASCII byte, the quoted name fails the -f test, and the file is
# silently left unchecked.
while IFS= read -r -d '' f; do
	[ -n "$f" ] && [ -f "$f" ] && files+=("$f")
done < <(
	{
		# Committed branch changes, plus every pre-commit worktree state. Keep
		# these separate: a path can appear in more than one state, so sort once
		# after collecting them all.
		git diff -z --name-only --diff-filter=ACMR "$mergebase"...HEAD -- "${pathspecs[@]}"
		git diff -z --cached --name-only --diff-filter=ACMR -- "${pathspecs[@]}"
		git diff -z --name-only --diff-filter=ACMR -- "${pathspecs[@]}"
		git ls-files -z --others --exclude-standard -- "${pathspecs[@]}"
	} | LC_ALL=C sort -zu
)

if [ "${#files[@]}" -eq 0 ]; then
	echo "check-format: no changed JS/TS files to check."
	exit 0
fi

echo "check-format: checking ${#files[@]} changed file(s) with oxfmt..."
# `--` keeps a file named like an option (`-x.ts`) a file.
exec ./node_modules/.bin/oxfmt --config oxfmtrc.json --check -- "${files[@]}"
