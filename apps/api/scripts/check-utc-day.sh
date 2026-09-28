#!/usr/bin/env bash
# The UTC day has one home: convex/lib/clock.ts (`utcDayStart`,
# `nextUtcDayStart`, `utcDayKey`, `denseDailySeries`). A day-bucketed counter is
# only correct while every writer and reader agree on the key, so a module that
# rolls its own day start or day key is a second spelling waiting to drift — the
# `sendDailyStats` writer and the marketing overview reader used to agree only
# because one had been copied from the other.
#
# The generator prints `path:<spelling>` for every hand-rolled day primitive
# under convex/ outside lib/clock.ts and tests:
#   setUTCHours(0, 0, 0, 0)        → utcDayStart(now)
#   toISOString().slice(0, 10)     → utcDayKey(now)
#   .split('T')[0]                 → utcDayKey(now)
#
# RATCHET on scripts/ratchet.sh, strict in both directions. The baseline
# (scripts/utc-day-baseline.txt) may only list a site that is NOT a day key or
# day start — a date written for a person, say — with its reason. A new entry
# means a module rolled its own day: import it from lib/clock.ts. A stale entry
# means a listed site went away: delete its line.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

generate() {
	[ -d convex ] || {
		echo "check-utc-day: convex/ missing — run from apps/api" >&2
		return 1
	}
	find convex -name "*.ts" \
		-not -path "*/_generated/*" \
		-not -path "*/__tests__/*" \
		! -name "*.test.ts" \
		! -path "convex/lib/clock.ts" \
		-exec awk '
			# Prose may name the spellings; only code is flagged.
			/^[[:space:]]*(\/\/|\*|\/\*)/ { next }
			/setUTCHours\(0, *0, *0, *0\)/ { print FILENAME ":setUTCHours(0, 0, 0, 0)" }
			/toISOString\(\)\.slice\(0, *10\)/ { print FILENAME ":toISOString().slice(0, 10)" }
			/\.split\((\x27|")T(\x27|")\)\[0\]/ { print FILENAME ":.split(\x27T\x27)[0]" }
		' {} + | LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/utc-day-baseline.txt \
	--seed "bash apps/api/scripts/check-utc-day.sh --write-baseline" \
	--ok "no module rolls its own UTC day outside lib/clock.ts" \
	--new-header "FAIL: {n} hand-rolled UTC day primitive(s) outside convex/lib/clock.ts:" \
	--new-advice "Import the day from convex/lib/clock.ts instead:
  setUTCHours(0, 0, 0, 0)       → utcDayStart(now)
  toISOString().slice(0, 10)    → utcDayKey(now)
  .split('T')[0]                → utcDayKey(now)
  a zero-filled daily series    → denseDailySeries(countsByKey, days, now)
Only a date that is not a day key (e.g. one written for a person) may be
listed in {baseline}, with its reason." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (site converted or removed):" \
	"$@" \
	-- bash "$self" --generate
