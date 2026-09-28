#!/usr/bin/env bash
#
# check-convex-root.sh
#
# The Convex root (`apps/api/convex/*.ts`) is frozen. New code goes into a
# domain folder or lib/ (see convex/CONVENTIONS.md "File layout"); the root
# keeps only the files the Convex CLI resolves there by name (schema.ts,
# convex.config.ts, http.ts, auth.config.ts, crons.ts), the ambient env.d.ts,
# and the legacy modules that have not been moved yet.
#
# A ratchet in both directions, like check-unused-indexes.sh: this script only
# prints the basenames of the root `.ts` files (`--generate`), and
# scripts/ratchet.sh compares them with scripts/convex-root-baseline.txt.
#   * A root file not in the baseline fails: move it into a folder.
#   * A baseline line whose file is gone fails as stale: delete the line, so the
#     root only ever shrinks.
#
# Moving a legacy module changes its public function path
# (`api.foo.bar` -> `api.domain.foo.bar`). A module whose functions a client,
# the web app or a scheduled job calls by path needs a one-release shim; see
# CONVENTIONS.md before moving one.
#
# Usage: `bash scripts/check-convex-root.sh` compares; `--generate` prints the
# root files; `--write-baseline` re-seeds the baseline (keeping its `#` header).
#
set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.." || exit 2

generate() {
	if [ ! -f convex/schema.ts ]; then
		echo "check-convex-root: apps/api/convex/schema.ts not found" >&2
		exit 2
	fi
	for file in convex/*.ts; do
		[ -f "$file" ] && printf '%s\n' "${file#convex/}"
	done | LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit 0
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/convex-root-baseline.txt \
	--seed "bash apps/api/scripts/check-convex-root.sh --write-baseline" \
	--ok "no new module at the Convex root" \
	--new-header "FAIL: {n} new file(s) at the Convex root (apps/api/convex/*.ts):" \
	--new-advice "The Convex root is frozen. Put the module in a domain folder or lib/
(see apps/api/convex/CONVENTIONS.md). Do NOT add it to {baseline}." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline}:" \
	--stale-advice "These files no longer sit at the Convex root. Delete the lines so the
root only shrinks." \
	"$@" \
	-- bash "$self" --generate
