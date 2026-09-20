#!/usr/bin/env bash
#
# Shared-production-export ratchet. `@owlat/shared` is consumed by every app, so
# a helper exported from it and called only by its own tests is public API with
# no user — and knip cannot see it, because knip counts a test as a consumer.
# scripts/list-shared-production-exports.ts does the source walk (production
# files only: no tests, comments, type-only imports or re-export barrels) and
# scripts/ratchet.sh compares its output against
# scripts/shared-production-export-baseline.txt, strict in both directions:
# a new unreached export fails, and a baseline entry that gained a production
# caller fails as stale so the inventory only moves down.

set -uo pipefail
cd "$(dirname "$0")/.."

exec scripts/ratchet.sh \
	--baseline scripts/shared-production-export-baseline.txt \
	--seed "bash scripts/check-shared-production-exports.sh --write-baseline" \
	--stderr \
	--ok "no new test-only shared exports" \
	--new-header "FAIL: {n} new @owlat/shared export(s) have no production caller:" \
	--new-advice "Wire them into production, keep them private, or remove them." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (export now has a production caller):" \
	--stale-advice "Delete these lines so the inventory only moves down." \
	"$@" \
	-- bun scripts/list-shared-production-exports.ts
