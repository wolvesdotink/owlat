#!/usr/bin/env bash
# Long Convex handlers ("Decision cores" in convex/CONVENTIONS.md).
#
# A handler that loads, decides and writes in one body grows with every rule
# added to it, and its rules can only be tested through the database. A long
# handler moves its decisions into a pure core (a `decide…` function taking a
# snapshot and the clock, returning what to write and what to run next) and
# keeps only the loads and the writes.
#
# scripts/handler-size-census.ts measures every registered handler under
# convex/ (scripts/lib/handlerSize.ts says what counts and how lines are
# counted) and prints `<module>:<name> <lines>` for each one over the cap
# (HANDLER_LINE_CAP there).
#
# Zero-tolerance gate on scripts/ratchet.sh --zero: there is no baseline, so
# any handler over the cap fails.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$(dirname "$0")/.."

exec "$repo_root/scripts/ratchet.sh" \
	--zero \
	--ok "no Convex handler is longer than the cap" \
	--new-header "FAIL: {n} Convex handler(s) longer than the cap:" \
	--new-advice "Move the decision out of the handler: a pure decide function beside the
module (registered in scripts/purity-roots.txt) that takes what the handler
loaded and the clock and returns what to write and what to schedule, with the
handler left to load, call and apply. Do NOT raise the cap." \
	"$@" \
	-- bun scripts/handler-size-census.ts
