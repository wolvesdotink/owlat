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
# equally when the allowlist (scripts/unused-index-allowlist.txt) holds an
# entry that is no longer unused. It is a ratchet in both directions: this
# script only prints the unused `table.index` pairs (`--generate`), and
# scripts/ratchet.sh owns the comparison with the allowlist, like
# check-query-authz.sh.
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
#   * `countIndexRange(db, table, 'name', …)` in lib/pagination.ts, whose
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
# Usage: `bash scripts/check-unused-indexes.sh` compares; `--generate` prints
# the unused pairs; `--write-baseline` re-seeds the allowlist (keeping its `#`
# header).
#
set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.." || exit 2

root="convex"
schema_root="$root/schema"

generate() {
	if [ ! -d "$schema_root" ]; then
		echo "FAIL: no schema directory at $schema_root" >&2
		exit 2
	fi

	# ── Declared indexes ─────────────────────────────────────────────────────
	# `table<TAB>name`, attributing each `.index()` to the nearest preceding
	# `foo: defineTable(` / `const foo = defineTable(`.
	local schema_files declared referenced calls declared_count
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
					nm = hit; sub("^[^\"" q "]*" qc, "", nm); sub(qc "$", "", nm)
					printf "%s\t%s\n", table, nm
					s = substr(s, RSTART + RLENGTH)
				}
			}
		'
	)

	# Guard against a silently broken extractor: every `.index(` call in the
	# schema must have parsed into a named declaration on a table. A shape the
	# parse stops matching (a name wrapped onto the next line, a table binding
	# spelled differently) fails here instead of reading as "no unused index".
	calls=$(
		printf '%s\n' "$schema_files" | xargs cat |
			grep -oE '\.(index|searchIndex|vectorIndex)\(' | grep -c . || true
	)
	declared_count=$(
		printf '%s\n' "$declared" | awk -F'\t' '$1 != "" && $2 != ""' | grep -c . || true
	)
	if [ "$declared_count" -ne "$calls" ]; then
		echo "FAIL: $calls index calls under $schema_root but only $declared_count parsed into a table and a name — the schema shape changed; update this check" >&2
		exit 2
	fi

	# ── Referenced names ─────────────────────────────────────────────────────
	referenced=$(
		find "$root" -name '*.ts' \
			-not -path "$schema_root/*" \
			-not -path '*/_generated/*' \
			-print0 2>/dev/null |
			xargs -0 -r grep -hoE "['\"][A-Za-z0-9_]+['\"]" 2>/dev/null |
			tr -d "'\"" | sort -u
	)

	# ── Unused: declared, and named nowhere outside schema/ ─────────────────
	awk -F'\t' '
		NR == FNR { referenced[$0] = 1; next }
		$2 != "" && !($2 in referenced) { print $1 "." $2 }
	' <(printf '%s\n' "$referenced") <(printf '%s\n' "$declared") |
		LC_ALL=C sort -u
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit 0
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/unused-index-allowlist.txt \
	--seed "bash apps/api/scripts/check-unused-indexes.sh --write-baseline" \
	--stderr \
	--ok "no Convex index declared but never queried" \
	--new-header "FAIL: {n} Convex index(es) declared but never queried:" \
	--new-advice "Every index costs a write on each insert and patch of its table. Delete the
index, or — if a landing change will query it — add '<table>.<index>' to
{baseline} with a comment saying which change needs it." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline}:" \
	--stale-advice "Each of these is now queried, or no longer declared. Delete the line." \
	"$@" \
	-- bash "$self" --generate
