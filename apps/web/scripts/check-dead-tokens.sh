#!/usr/bin/env bash
#
# Fail if a Tailwind utility references a design token that isn't defined in the
# @theme block (packages/ui/assets/css/tokens.css). Tailwind v4 generates a
# utility only for defined tokens and errors on nothing, so these ship silently
# as zero-CSS no-ops — which is how destructive Delete buttons once rendered in
# neutral ambient colour instead of red, and how `accent-lime` left checkboxes
# at the UA default tick colour. Two complementary guards:
#
#   1. DEAD — an explicit denylist of retired token names (bg-/text-). Extend it
#      when a token is renamed/removed.
#   2. accent-<name> — a GENERIC colour check: every `accent-<name>` class must
#      resolve to a `--color-<name>` token in tokens.css. Arbitrary values
#      (`accent-[var(--color-brand)]`, `accent-[#abc]`) are skipped — they are
#      self-contained and don't depend on a named token.
#
# Usage: check-dead-tokens.sh [root...]
# Roots are optional and exist so the rules can be self-tested against a fixture
# tree (`app/__tests__/deadTokens.lint.test.ts`); pass them ABSOLUTE, because
# this script cd's to apps/web first.
set -euo pipefail
cd "$(dirname "$0")/.."

TOKENS_CSS="../../packages/ui/assets/css/tokens.css"
if [ ! -f "$TOKENS_CSS" ]; then
	echo "✗ tokens.css not found at $TOKENS_CSS" >&2
	exit 1
fi

# The app is not the only place a zero-CSS class can hide: the shared components
# in packages/ui paint the same screens from the same @theme block and are
# covered by no other check.
if [ "$#" -eq 0 ]; then
	roots=(app ../../packages/ui/components)
else
	roots=("$@")
fi

# A MISSING ROOT IS A FAILURE, NOT AN EMPTY SCAN. Rename or move a root and the
# guard would otherwise keep printing it as covered while reading nothing there —
# `find` reports that on stderr and the process substitution below swallows its
# exit status, so the check has to be its own statement.
for root in "${roots[@]}"; do
	if [ ! -d "$root" ]; then
		echo "✗ scan root does not exist: $root (roots: ${roots[*]})" >&2
		exit 1
	fi
done

# TESTS ARE NOT MARKUP. A class name in a spec is never compiled into anything
# Tailwind renders, so it can neither emit CSS nor fail to — and the assertions
# that pin these very rules quote every banned name by construction.
mapfile -t files < <(
	find "${roots[@]}" -type f \( -name '*.vue' -o -name '*.ts' \) \
		-not -path '*/node_modules/*' -not -path '*/__tests__/*' -not -name '*.test.ts' |
		sort
)
if [ "${#files[@]}" -eq 0 ]; then
	echo "✗ no .vue/.ts files under: ${roots[*]}" >&2
	exit 1
fi

fail=0

# ── Guard 1: explicit denylist of retired tokens ──────────────────────────────
# `text-primary` is boundary-guarded so the legitimate `text-text-primary`,
# `bg-text-primary` and `--color-text-primary` do not read as hits.
DEAD='bg-bg-surface-elevated|bg-bg-default|text-danger|bg-danger|bg-surface-subtle|(^|[^-[:alnum:]])text-primary([^-[:alnum:]]|$)'
hits=$(grep -HnE "$DEAD" "${files[@]}" 2>/dev/null || true)
if [ -n "$hits" ]; then
	echo "✗ dead design tokens (no matching @theme token → emits zero CSS):"
	echo "$hits"
	echo "  Use the canonical names: bg-bg-elevated / bg-bg-base / text-error / bg-error /"
	echo "  bg-bg-surface / text-brand"
	fail=1
fi

# ── Guard 2: every accent-<name> must map to a --color-<name> token ───────────
# Defined colour token names, e.g. `--color-brand-hover` → `brand-hover`.
defined=$(grep -oE -- '--color-[a-z0-9-]+' "$TOKENS_CSS" | sed 's/^--color-//' | sort -u)
# Used accent-<name> utilities (skip arbitrary `accent-[...]` values).
used=$(grep -hoE 'accent-[a-z][a-z0-9-]*' "${files[@]}" 2>/dev/null | sed 's/^accent-//' | sort -u || true)
bad=""
for name in $used; do
	if ! grep -qxF "$name" <<<"$defined"; then
		bad+="accent-$name"$'\n'
	fi
done
if [ -n "$bad" ]; then
	echo "✗ accent-* classes referencing colour tokens absent from tokens.css (emit zero CSS):"
	printf '%s' "$bad" | grep . | while read -r cls; do
		grep -HnE "\b${cls}\b" "${files[@]}" 2>/dev/null || true
	done
	echo "  Drop the class or use a defined token (e.g. accent-brand / accent-[var(--color-brand)])."
	fail=1
fi

[ "$fail" -eq 1 ] && exit 1
# The scanned roots are named, so a passing run states what it actually covered.
echo "ok:   no dead design tokens in ${roots[*]}"
