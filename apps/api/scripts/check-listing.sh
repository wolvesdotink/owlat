#!/usr/bin/env bash
# Enforce the Resource listing seam (ADR-0037). Every "search → filter → sort →
# paginate → count" path must flow through the Listing engine
# (convex/lib/listing.ts) via a per-entity Listing descriptor
# (convex/<entity>/listing.ts). Run as part of `bun run lint`, sibling to
# check-errors.sh and check-env.sh.
#
# Two checks, both scoped to apps/api/convex/ source (excludes _generated and
# tests), and both excluding the engine + descriptors themselves:
#
#   1. No `paginateArray(` in query files. Its stringified-integer offset was
#      not a real Convex cursor; all list pagination now flows through the
#      engine's database-level pagination with a real, opaque cursor. (The
#      offset helper in _utils/pagination.ts is a different, unused function and
#      is excluded by path.)
#   2. No manual `paginationOpts.numItems + 1` "take n+1 to compute hasMore"
#      pagination. That hand-rolled pattern is exactly what produced the
#      `'search'`-sentinel fake cursor (search served a single page forever).
#      The engine paginates the search index with a real cursor instead.
#
# `.collect()`-then-filter-then-paginate — the third open-coded shape — is held
# down by the `.collect()` baseline in check-convex-patterns.sh; porting a list
# query to the engine only ever lowers that count.
#
# This is the locality guarantee made permanent — what stops the list-query
# sites from regrowing and a fifth list contract from appearing.

set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

# Shared exclusions: generated code, tests, the engine, the per-entity
# descriptors, and the two pagination-primitive definition files.
filter_excludes() {
	grep -v "/_generated/" \
		| grep -v "/__tests__/" \
		| grep -v "\.test\.ts:" \
		| grep -v "convex/lib/listing\.ts:" \
		| grep -v "convex/lib/pagination\.ts:" \
		| grep -v "convex/_utils/pagination\.ts:" \
		| grep -v "/listing\.ts:"
}

# ── Check 1: no bespoke array pagination in query files ──────────────────────
paginate_array_hits=$(grep -rn "paginateArray(" convex --include="*.ts" 2>/dev/null \
	| filter_excludes || true)

if [[ -n "$paginate_array_hits" ]]; then
	echo "ERROR: 'paginateArray(' outside the Listing engine:"
	echo ""
	echo "$paginate_array_hits"
	echo ""
	echo "Route the list through listResources(db, <entityListing>, args) from"
	echo "convex/lib/listing.ts — it paginates at the database with a real cursor."
	echo ""
	fail=1
fi

# ── Check 2: no manual take-(n+1) hasMore pagination ─────────────────────────
manual_hasmore_hits=$(grep -rn "numItems + 1" convex --include="*.ts" 2>/dev/null \
	| filter_excludes || true)

if [[ -n "$manual_hasmore_hits" ]]; then
	echo "ERROR: manual 'numItems + 1' pagination outside the Listing engine:"
	echo ""
	echo "$manual_hasmore_hits"
	echo ""
	echo "Hand-rolled take-(n+1) pagination is the source of the '\''search'\''-sentinel"
	echo "fake cursor. Use listResources(db, <entityListing>, args) — its search path"
	echo "paginates the search index with a real, multi-page Convex cursor."
	echo ""
	fail=1
fi

if [[ "$fail" -ne 0 ]]; then
	echo "Resource listing check failed. See docs/adr/0037-resource-listing-engine.md."
	exit 1
fi

echo "ok:   resource listing (no paginateArray, no manual take-(n+1) pagination)"
