#!/usr/bin/env bash
#
# Owlat lint ratchet. The rules in packages/oxlint-plugin-owlat run in every
# oxlint pass (oxlintrc.json `jsPlugins`). A rule configured as an error there
# is enforced outright by each workspace's `lint`. A rule that lands while code
# still breaks it is configured as a warning instead, and this gate owns its
# debt: scripts/owlat-lint-findings.ts lists every owlat warning and
# scripts/ratchet.sh compares the list against scripts/owlat-lint-baseline.txt,
# strict in both directions. A new finding fails (fix it, do not add a line);
# a baseline line nothing reports any more fails as stale (delete it).
#
# Adding a rule with debt: set it to "warn" in oxlintrc.json, then seed the
# baseline with `bash scripts/check-owlat-lint.sh --write-baseline`. Once the
# baseline holds no line for the rule, switch it to "error".

set -uo pipefail
cd "$(dirname "$0")/.."

exec scripts/ratchet.sh \
	--baseline scripts/owlat-lint-baseline.txt \
	--seed "bash scripts/check-owlat-lint.sh --write-baseline" \
	--ok "no new owlat lint findings" \
	--new-header "FAIL: {n} owlat lint finding(s) not in {baseline}:" \
	--new-advice "Fix them. Do NOT add new lines to {baseline}; it is frozen debt." \
	"$@" \
	-- bun scripts/owlat-lint-findings.ts
