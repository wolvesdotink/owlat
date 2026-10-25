#!/usr/bin/env bash
# Long Convex handlers ("Decision cores" in convex/CONVENTIONS.md).
#
# A handler that loads, decides and writes in one body grows with every rule
# added to it, and its rules can only be tested through the database. The
# longest handlers move their decisions into a pure core (a `decide…` function
# taking a snapshot and the clock, returning what to write and what to run
# next) and keep only the loads and the writes.
#
# scripts/handler-size-census.ts measures every registered handler under
# convex/ (scripts/lib/handlerSize.ts says what counts and how lines are
# counted) and prints `<module>:<name> <lines>` for each one over the cap
# (HANDLER_LINE_CAP there). The comparison lives in scripts/ratchet.sh and is
# strict both ways: a handler that grows, or a new one that crosses the cap,
# fails; one that shrinks fails as stale until its line carries the new
# length (or goes, once it is under the cap), so the tracked lengths only go
# down.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$(dirname "$0")/.."

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/handler-size-baseline.txt \
	--seed "bash apps/api/scripts/check-handler-size.sh --write-baseline" \
	--ok "no Convex handler is longer than its baseline allows" \
	--new-header "FAIL: {n} handler length(s) not in {baseline}:" \
	--new-advice "A handler past the cap, or longer than its baseline line, grew. Move the
decision out of it: a pure decide function beside the module (registered in
scripts/purity-roots.txt) that takes what the handler loaded and the clock and
returns what to write and what to schedule, with the handler left to load,
call and apply. If the same handler also has a stale line below, it grew from
that length. Do NOT raise its line in {baseline}; it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (handler shrank, moved or went under the cap):" \
	--stale-advice "Replace the line with the handler's new length from the block above, or
delete it when the handler is no longer listed there." \
	"$@" \
	-- bun scripts/handler-size-census.ts
