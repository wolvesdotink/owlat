#!/usr/bin/env bash
#
# check-unused-indexes.sh
#
# Every `.index()` on a Convex table is paid for on every write to that table:
# an insert or patch maintains each index whether or not a query ever reads it.
# Declared-but-never-queried indexes are therefore a standing write tax, and
# they accrete easily — an index is usually added in the same commit as the
# query that motivated it, and survives the query's removal.
#
# This gate fails when a schema declares an index no code reads, and fails
# equally when the allowlist below holds an entry that is no longer unused. It
# is a ratchet in both directions, like check-body-access.sh.
#
# HOW A REFERENCE IS RECOGNISED
#
# Index names reach Convex as plain strings, and not only through
# `.withIndex('name', …)`. The tree also names them:
#
#   * `.withSearchIndex('name', …)` — text search indexes.
#   * `index:` / `filterIndexes:` / `sortIndexes:` inside the ADR-0037 listing
#     descriptors, which lib/listing.ts forwards to `.withIndex()` as a
#     variable (see `browsePage`).
#   * `countWithPagination(db, table, 'name', …)` in lib/pagination.ts, whose
#     index argument is likewise a caller-supplied literal.
#   * local helper parameters — knowledge/graph.ts `drainDirection(index, …)`
#     is called with `'by_from'` / `'by_to'` literals.
#
# Every one of those is ultimately a quoted literal somewhere under convex/, so
# rather than enumerate call shapes (and miss the next one) this gate treats
# ANY quoted identifier-like literal outside schema/ as a reference. That is
# deliberately conservative: it can call an index used when the string merely
# happens to appear, but it cannot fail the build over a query it did not
# understand. `grep -rn "withIndex(" convex --include='*.ts'` shows the only
# non-literal first arguments are the four dynamic sites listed above, each fed
# from literals in the same tree.
#
# Matching is by index NAME, not by table.name pair, because a descriptor
# literal carries no table. Two tables sharing an index name therefore vouch
# for each other; that is the price of covering the dynamic sites, and it only
# ever under-reports.
#
# Tests count as references. An index no production code reads but a test names
# is a narrower problem than a fully forgotten one, and outside this gate's job.
#
# Args (for the self-test): $1 overrides the scan root (default `convex`), $2
# the allowlist path.
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

root="${1:-convex}"
allowlist="${2:-scripts/unused-index-allowlist.txt}"
schema_root="$root/schema"

if [ ! -d "$schema_root" ]; then
	echo "FAIL: no schema directory at $schema_root" >&2
	exit 2
fi

# ── Declared indexes ─────────────────────────────────────────────────────────
# `table<TAB>name<TAB>kind<TAB>file:line`, attributing each `.index()` to the
# nearest preceding `foo: defineTable(` / `const foo = defineTable(`.
schema_files=$(find "$schema_root" -name '*.ts' -not -path '*/__tests__/*' 2>/dev/null | sort)
if [ -z "$schema_files" ]; then
	echo "FAIL: no schema files under $schema_root" >&2
	exit 2
fi

declared=$(
	printf '%s\n' "$schema_files" | xargs awk -v q="'" '
		{
			# Table in scope: the enclosing defineTable() binding.
			if ($0 ~ /defineTable\(/) {
				line = $0
				sub(/^[ \t]*/, "", line)
				sub(/^const[ \t]+/, "", line)
				if (line ~ /^[A-Za-z0-9_]+[ \t]*[:=][ \t]*defineTable\(/) {
					name = line
					sub(/[ \t]*[:=].*$/, "", name)
					table = name
				}
			}
			qc = "[\"" q "]"
			pat = "\\.(index|searchIndex|vectorIndex)\\([ \t]*" qc "[A-Za-z0-9_]+" qc
			s = $0
			while (match(s, pat)) {
				hit = substr(s, RSTART, RLENGTH)
				kind = hit; sub(/^\./, "", kind); sub(/\(.*$/, "", kind)
				nm = hit; sub("^[^\"" q "]*" qc, "", nm); sub(qc "$", "", nm)
				printf "%s\t%s\t%s\t%s:%d\n", table, nm, kind, FILENAME, FNR
				s = substr(s, RSTART + RLENGTH)
			}
		}
	'
)

declared_count=$(printf '%s' "$declared" | grep -c . || true)

# Guard against a silently broken extractor on the real tree: the schema has
# hundreds of indexes, so a near-empty result means the parse stopped matching,
# not that the indexes went away.
if [ "$root" = "convex" ] && [ "$declared_count" -lt 100 ]; then
	echo "FAIL: only $declared_count index declarations parsed out of $schema_root — the schema shape changed; update this check" >&2
	exit 2
fi

# ── Referenced names ─────────────────────────────────────────────────────────
referenced=$(
	find "$root" -name '*.ts' \
		-not -path "$schema_root/*" \
		-not -path '*/_generated/*' \
		-print0 2>/dev/null |
		xargs -0 grep -hoE "['\"][A-Za-z0-9_]+['\"]" 2>/dev/null |
		tr -d "'\"" | sort -u
)

# ── Allowlist ────────────────────────────────────────────────────────────────
# `table.index_name` per line; `#` comments and blank lines ignored.
allowed=""
if [ -f "$allowlist" ]; then
	allowed=$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$allowlist" | grep -v '^$' | sort -u)
fi

# ── Compare ──────────────────────────────────────────────────────────────────
unused=""
while IFS=$'\t' read -r table name kind loc; do
	[ -n "${name:-}" ] || continue
	if ! grep -qxF "$name" <<<"$referenced"; then
		unused="${unused}${table}.${name}"$'\t'"${kind}"$'\t'"${loc}"$'\n'
	fi
done < <(printf '%s\n' "$declared")

fail=0

unexpected=""
while IFS=$'\t' read -r pair kind loc; do
	[ -n "${pair:-}" ] || continue
	if ! grep -qxF "$pair" <<<"$allowed"; then
		unexpected="${unexpected}  ${pair} [${kind}] ${loc}"$'\n'
	fi
done < <(printf '%s' "$unused")

if [ -n "$unexpected" ]; then
	count=$(printf '%s' "$unexpected" | grep -c .)
	echo "FAIL: $count Convex index(es) declared but never queried:" >&2
	printf '%s' "$unexpected" >&2
	echo "" >&2
	echo "Every index costs a write on each insert and patch of its table. Delete the" >&2
	echo "index, or — if a landing change will query it — add '<table>.<index>' to" >&2
	echo "$allowlist with a comment saying which change needs it." >&2
	fail=1
fi

# Stale allowlist entries: the entry is now queried, or its index is gone.
unused_pairs=$(printf '%s' "$unused" | cut -f1 | sort -u)
stale=""
while IFS= read -r pair; do
	[ -n "$pair" ] || continue
	if ! grep -qxF "$pair" <<<"$unused_pairs"; then
		stale="${stale}  ${pair}"$'\n'
	fi
done < <(printf '%s\n' "$allowed")

if [ -n "$stale" ]; then
	count=$(printf '%s' "$stale" | grep -c .)
	echo "FAIL: $count stale entry(ies) in $allowlist:" >&2
	printf '%s' "$stale" >&2
	echo "" >&2
	echo "Each of these is now queried, or no longer declared. Delete the line." >&2
	fail=1
fi

[ "$fail" -eq 1 ] && exit 1

allowed_count=$(printf '%s' "$allowed" | grep -c . || true)
echo "check-unused-indexes: OK ($declared_count indexes declared, $allowed_count allowlisted)"
