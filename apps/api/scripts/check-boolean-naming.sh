#!/usr/bin/env bash
# Enforces the boolean prefix convention for schema fields
# (CONVENTIONS.md → "Boolean naming"): every `v.boolean()` /
# `v.optional(v.boolean())` field in convex/schema/*.ts must be named
# `is<Capital>...` (`isVerified`, `isEnabled`, `isActive`, ...) or
# `has<Capital>...` (`hasAttachments`, `hasOpened`, ...).
#
# Status-string enums that merely spell a literal like `'verified'`
# (e.g. `domains.status`) are NOT booleans and never match — only fields
# whose validator IS a boolean are scanned.
#
# Two lists cover the fields that do not follow the convention:
#
#   * scripts/boolean-naming-wire-fields.txt is NOT debt. Each field mirrors
#     an external wire vocabulary (IMAP flags, the MTA's warming report), so a
#     rename is a protocol change, not a naming fix. The generator drops these
#     fields before the comparison, and fails if a line there no longer matches
#     a field (delete the line). A new line needs the same kind of reason.
#   * scripts/boolean-naming-baseline.txt is debt: fields on production
#     tables whose rename is an expand → migrate → contract over at least two
#     releases (CONVENTIONS.md → "Expand, migrate, contract"). It is a RATCHET
#     on scripts/ratchet.sh, strict in both directions: an unlisted violation
#     fails (a new mis-named boolean field), and a stale entry fails (the field
#     was renamed or removed, so its line must be deleted and the debt count
#     only moves down). Once it is empty, switch the gate to `--zero`.
#
# Key format is `file:fieldName` (one line per occurrence); duplicate field
# names on sibling tables in the same file appear once per table, and `comm`
# pairs the repeats, so adding the same bad name to a new table is still
# caught.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

wire_list=scripts/boolean-naming-wire-fields.txt

# A boolean *field*: `<name>: v.boolean()` or `<name>: v.optional(v.boolean())`
# at the start of a line (after indentation). The leading anchor excludes
# nested uses like `v.record(v.string(), v.boolean())` whose field name is not
# itself a boolean. The key is `file:field` (file relative to convex/schema/),
# one line per occurrence so duplicate names on sibling tables are paired by
# `comm`.
misnamed() {
	for f in $(find convex/schema -name "*.ts" -not -path "*/_generated/*" -not -path "*/__tests__/*"); do
		grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(v\.optional\(v\.boolean\(\)\)|v\.boolean\(\))' "$f" \
			| sed -E "s|^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*):.*|${f#convex/schema/}:\1|"
	done | grep -vE ':(is|has)[A-Z]' | LC_ALL=C sort || true
}

# The mis-named fields minus the wire-mirrored ones. A wire-list line that
# matches no mis-named field fails here, so that list cannot hold a renamed or
# removed field (or one that now follows the convention) and hide a later
# field that reuses its key.
generate() {
	if [ ! -f "$wire_list" ]; then
		echo "FAIL: $wire_list missing." >&2
		return 1
	fi
	local current wire stale
	current=$(misnamed)
	wire=$(grep -v '^[[:space:]]*#' "$wire_list" | grep . | LC_ALL=C sort)
	stale=$(LC_ALL=C comm -13 <(printf '%s\n' "$current" | grep .) <(printf '%s\n' "$wire" | grep .))
	if [ -n "$stale" ]; then
		{
			echo "FAIL: $(printf '%s\n' "$stale" | grep -c .) stale entr(y/ies) in $wire_list (no mis-named boolean field matches):"
			echo ""
			printf '%s\n' "$stale"
			echo ""
			echo "Delete these lines."
		} >&2
		return 1
	fi
	LC_ALL=C comm -23 <(printf '%s\n' "$current" | grep .) <(printf '%s\n' "$wire" | grep .)
	return 0
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/boolean-naming-baseline.txt \
	--seed "bash apps/api/scripts/check-boolean-naming.sh --write-baseline" \
	--ok "no new boolean field without an is* or has* prefix" \
	--new-header "FAIL: {n} boolean schema field(s) without an is* or has* prefix:" \
	--new-advice "Boolean fields use the is* or has* prefix (CONVENTIONS.md → Boolean naming):
  isVerified, isEnabled, isActive, isDefault, hasAttachments, ...
Rename the field. A field whose name an external protocol fixes (an IMAP
flag, a field the MTA reports) goes in $wire_list with its
reason. Do NOT add new entries to {baseline}; it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (field renamed or removed):" \
	"$@" \
	-- bash "$self" --generate
