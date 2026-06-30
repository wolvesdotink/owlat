#!/usr/bin/env bash
# Enforces the `is*`-prefix convention for boolean schema fields
# (CONVENTIONS.md → "Boolean naming"): every `v.boolean()` /
# `v.optional(v.boolean())` field in convex/schema/*.ts must be named
# `is<Capital>...` (`isVerified`, `isEnabled`, `isActive`, ...).
#
# Status-string enums that merely spell a literal like `'verified'`
# (e.g. `domains.status`) are NOT booleans and never match — only fields
# whose validator IS a boolean are scanned.
#
# ~20 legacy fields predate the rule and sit on production tables, where a
# rename is a dual-write migration we are deliberately not paying now. They
# are frozen in scripts/boolean-naming-baseline.txt so the gate stops the
# debt from GROWING without forcing a rename. Like check-query-authz.sh this
# is a RATCHET, strict in both directions:
#
#   * an unlisted violation fails  — a new mis-named boolean field, and
#   * a stale baseline entry fails — the field was renamed/removed, so its
#     line must be deleted (the debt count only moves down).
#
# Key format is `file:fieldName` (one line per occurrence); duplicate field
# names on sibling tables in the same file appear once per table, and `comm`
# pairs the repeats, so adding the same bad name to a new table is still
# caught.

cd "$(dirname "$0")/.."

baseline_file="scripts/boolean-naming-baseline.txt"

# A boolean *field*: `<name>: v.boolean()` or `<name>: v.optional(v.boolean())`
# at the start of a line (after indentation). The leading anchor excludes
# nested uses like `v.record(v.string(), v.boolean())` whose field name is not
# itself a boolean. The key is `file:field` (file relative to convex/schema/),
# one line per occurrence so duplicate names on sibling tables are paired by
# `comm`.
violations=$(
	for f in $(find convex/schema -name "*.ts" -not -path "*/_generated/*" -not -path "*/__tests__/*"); do
		grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(v\.optional\(v\.boolean\(\)\)|v\.boolean\(\))' "$f" \
			| sed -E "s|^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*):.*|${f#convex/schema/}:\1|"
	done | grep -vE ':is[A-Z]' | sort || true
)

new=$(comm -23 <(printf '%s\n' "$violations" | grep . || true) <(sort "$baseline_file"))
stale=$(comm -13 <(printf '%s\n' "$violations" | grep . || true) <(sort "$baseline_file"))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count boolean schema field(s) without the required is* prefix:"
	echo ""
	echo "$new"
	echo ""
	echo "Boolean fields use the is* prefix (CONVENTIONS.md → Boolean naming):"
	echo "  isVerified, isEnabled, isActive, isDefault, isPrimary, ..."
	echo "Rename the field, or — if it sits on an existing production table and"
	echo "a dual-write migration is out of scope — that is the only case the"
	echo "frozen baseline covers. Do NOT add new entries to $baseline_file."
	fail=1
fi
if [ -n "$stale" ]; then
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale entr(y/ies) in $baseline_file (field renamed or removed):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines so the ratchet only moves down."
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

baseline_count=$(grep -c . "$baseline_file")
echo "ok:   no new boolean field without the is* prefix ($baseline_count baseline entries remain)"
