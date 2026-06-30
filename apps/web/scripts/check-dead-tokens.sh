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
set -euo pipefail
cd "$(dirname "$0")/.."

TOKENS_CSS="../../packages/ui/assets/css/tokens.css"
if [ ! -f "$TOKENS_CSS" ]; then
	echo "✗ tokens.css not found at $TOKENS_CSS" >&2
	exit 1
fi

fail=0

# ── Guard 1: explicit denylist of retired tokens ──────────────────────────────
DEAD='bg-bg-surface-elevated|bg-bg-default|text-danger|bg-danger'
hits=$(grep -rnE "$DEAD" app/ --include='*.vue' --include='*.ts' 2>/dev/null || true)
if [ -n "$hits" ]; then
	echo "✗ dead design tokens (no matching @theme token → emits zero CSS):"
	echo "$hits"
	echo "  Use the canonical names: bg-bg-elevated / bg-bg-base / text-error / bg-error"
	fail=1
fi

# ── Guard 2: every accent-<name> must map to a --color-<name> token ───────────
# Defined colour token names, e.g. `--color-brand-hover` → `brand-hover`.
defined=$(grep -oE -- '--color-[a-z0-9-]+' "$TOKENS_CSS" | sed 's/^--color-//' | sort -u)
# Used accent-<name> utilities (skip arbitrary `accent-[...]` values).
used=$(grep -rhoE 'accent-[a-z][a-z0-9-]*' app/ --include='*.vue' --include='*.ts' 2>/dev/null \
	| sed 's/^accent-//' | sort -u || true)
bad=""
for name in $used; do
	if ! grep -qxF "$name" <<<"$defined"; then
		bad+="accent-$name"$'\n'
	fi
done
if [ -n "$bad" ]; then
	echo "✗ accent-* classes referencing colour tokens absent from tokens.css (emit zero CSS):"
	printf '%s' "$bad" | grep . | while read -r cls; do
		grep -rnE "\b${cls}\b" app/ --include='*.vue' --include='*.ts' 2>/dev/null || true
	done
	echo "  Drop the class or use a defined token (e.g. accent-brand / accent-[var(--color-brand)])."
	fail=1
fi

[ "$fail" -eq 1 ] && exit 1
echo "ok:   no dead design tokens"
