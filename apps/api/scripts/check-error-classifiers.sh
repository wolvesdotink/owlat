#!/usr/bin/env bash
# A failure the backend raises for itself is classified by its type, never by
# its wording. A module that needs to tell one of its own failures apart throws
# an `InternalFailure` (convex/_utils/errors.ts) and the caller switches on
# `internalFailureOf(error)?.kind`; an Operation error is read by `category`
# (`extractOperationError`). Matching on message text breaks silently: reword
# the message and the classifier misses it, or an unrelated error that happens
# to use the same words is taken for it.
#
# The generator prints `path:<spelling>` for every message-text classifier
# under convex/ outside tests and generated code, one line per occurrence:
#   <…message|…Message|errorText|…msg>.includes( / startsWith( / endsWith( /
#   match( / search(
#   .test(<…message|…Message|errorText|…msg>)
# Comment lines are prose and are not read.
#
# RATCHET on scripts/ratchet.sh, strict in both directions. The baseline
# (scripts/error-classifier-baseline.txt) lists only adapters for text this
# codebase does not write: platform errors that carry no code (Convex limits
# and validation, node:dns) and external provider replies. A new entry means a
# module classifies an error by its wording: type the failure instead. A stale
# entry means a listed site went away: delete its line.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

generate() {
	[ -d convex ] || {
		echo "check-error-classifiers: convex/ missing — run from apps/api" >&2
		return 1
	}
	find convex -name "*.ts" \
		-not -path "*/_generated/*" \
		-not -path "*/__tests__/*" \
		! -name "*.test.ts" \
		-exec awk '
			/^[[:space:]]*(\/\/|\*|\/\*)/ { next }
			{
				line = $0
				while (match(line, /[A-Za-z0-9_$]*([Mm]essage|errorText|[Mm]sg)\.(includes|startsWith|endsWith|match|search)\(|\.test\([A-Za-z0-9_$.]*([Mm]essage|errorText|[Mm]sg)\)/)) {
					spelling = substr(line, RSTART, RLENGTH)
					sub(/\($/, "", spelling)
					print FILENAME ":" spelling
					line = substr(line, RSTART + RLENGTH)
				}
			}
		' {} + | LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/error-classifier-baseline.txt \
	--seed "bash apps/api/scripts/check-error-classifiers.sh --write-baseline" \
	--ok "no backend failure is classified by its message text" \
	--new-header "FAIL: {n} error classifier(s) that read message text:" \
	--new-advice "Classify by type, not wording:
  a failure this backend raises    → throw new InternalFailure(kind, …) from
                                     convex/_utils/errors.ts and switch on
                                     internalFailureOf(error)?.kind
  an Operation error (ConvexError) → extractOperationError(error)?.category
Only text this codebase does not write (a platform error with no code, an
external provider's reply) may be listed in {baseline}, with its reason." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (site converted or removed):" \
	"$@" \
	-- bash "$self" --generate
