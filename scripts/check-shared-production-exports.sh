#!/usr/bin/env bash
#
# Shared-production-export gate. `@owlat/shared` is consumed by every app, so
# a helper exported from it and called only by its own tests is public API with
# no user — and knip cannot see it, because knip counts a test as a consumer.
# scripts/list-shared-production-exports.ts does the source walk (production
# files only: no tests, comments, type-only imports or re-export barrels) and
# scripts/ratchet.sh --zero fails on any export it reports: there is no
# baseline, so an unreached export is fixed, never recorded.

set -uo pipefail
cd "$(dirname "$0")/.."

exec scripts/ratchet.sh \
	--zero \
	--stderr \
	--ok "no test-only shared exports" \
	--new-header "FAIL: {n} @owlat/shared export(s) have no production caller:" \
	--new-advice "Wire them into production, keep them private, or remove them." \
	"$@" \
	-- bun scripts/list-shared-production-exports.ts
