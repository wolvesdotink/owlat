#!/usr/bin/env bash
# Actions commit once ("Actions commit once" in convex/CONVENTIONS.md).
#
# Each `ctx.runMutation` an action makes is a separate transaction, so an
# action that commits several times leaves the earlier commits behind when it
# fails between them. An action reads with runQuery, does its external I/O,
# then makes ONE commit mutation that re-checks its preconditions and
# schedules what comes next.
#
# scripts/action-commit-census.ts counts, per action, the most runMutation
# calls one run can make (scripts/lib/actionCommits.ts says how branches,
# loops and same-module helpers count) and prints one entry per commit past
# the first: `<module>:<action> #<n>`. A call whose statement sits directly
# under a `// checkpoint: <reason>` line does not count; the census itself
# fails on a marker that exempts nothing or gives no reason.
#
# The comparison lives in scripts/ratchet.sh and is strict both ways: a new
# entry (a new multi-commit action, or one more commit in a listed one) fails,
# and a stale one (an action converted or a commit removed) fails until its
# line is deleted, so the debt only goes down.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$(dirname "$0")/.."

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/action-commit-baseline.txt \
	--seed "bash apps/api/scripts/check-action-commits.sh --write-baseline" \
	--ok "no action commits more often than its baseline allows" \
	--new-header "FAIL: {n} action commit(s) past the first, not in {baseline}:" \
	--new-advice "An action makes one commit: read with ctx.runQuery, do the external I/O,
then call ONE mutation that re-checks its preconditions, writes everything and
schedules what comes next. Fold the extra runMutation calls into that mutation
(reuse the owning module's MutationCtx helpers), or, for a write that is meant
to stand on its own if the action fails after it (a chunked job's checkpoint,
a lease claimed before an external effect), put a
'// checkpoint: <why it may stand alone>' line directly above its statement.
Do NOT add lines to {baseline}; it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (commit removed or action converted):" \
	"$@" \
	-- bun scripts/action-commit-census.ts
