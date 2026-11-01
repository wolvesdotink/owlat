#!/usr/bin/env bash
#
# check-convex-root.sh
#
# The Convex root (`apps/api/convex/*.ts`) holds a fixed set of files, listed
# below. Every other module goes into a domain folder or lib/ (see
# convex/CONVENTIONS.md "File layout"). There is no baseline: a root `.ts` file
# outside the set fails (scripts/ratchet.sh --zero), and so does a listed file
# that is missing, because the Convex CLI resolves most of them by name.
#
# Usage: `bash scripts/check-convex-root.sh` checks; `--generate` prints the
# root files outside the set.
#
set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.." || exit 2

# schema.ts, convex.config.ts, http.ts, auth.config.ts and crons.ts: the Convex
# CLI reads them at the root by exact name, and a moved auth.config.ts silently
# drops every auth provider. env.d.ts: the ambient declarations of the Convex
# tsconfig.
#
# codeWorkTasks.ts: the code-worker addresses its functions by string path
# (`codeWorkTasks:claim`, ... in apps/code-worker/src/convexClient.ts), and
# apps/convex-fn-proxy/src/allowlist.ts admits exactly those paths as the
# worker's security boundary. Moving it takes a code-worker wire-version bump,
# a proxy allowlist carrying both paths for a release, and shims at the old
# paths (CONVENTIONS.md "Worker wire versions"), for a rename that changes no
# behaviour.
ALLOWED_ROOT_FILES=(
	auth.config.ts
	codeWorkTasks.ts
	convex.config.ts
	crons.ts
	env.d.ts
	http.ts
	schema.ts
)

generate() {
	local name
	for name in "${ALLOWED_ROOT_FILES[@]}"; do
		if [ ! -f "convex/$name" ]; then
			echo "check-convex-root: apps/api/convex/$name is missing. The Convex CLI and the" >&2
			echo "worker paths expect it at the root; if it moved on purpose, take it out of" >&2
			echo "ALLOWED_ROOT_FILES in scripts/check-convex-root.sh in the same change." >&2
			exit 2
		fi
	done
	local file
	for file in convex/*.ts; do
		[ -f "$file" ] || continue
		name="${file#convex/}"
		case " ${ALLOWED_ROOT_FILES[*]} " in
		*" $name "*) ;;
		*) printf '%s\n' "$name" ;;
		esac
	done | LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit 0
fi

exec "$repo_root/scripts/ratchet.sh" \
	--zero \
	--ok "the Convex root holds only its fixed files" \
	--new-header "FAIL: {n} file(s) at the Convex root outside its fixed set (apps/api/convex/*.ts):" \
	--new-advice "Put the module in a domain folder or lib/ (see apps/api/convex/CONVENTIONS.md,
\"The root is frozen\"). The set in scripts/check-convex-root.sh holds only the files
the Convex CLI or a worker resolves at the root." \
	"$@" \
	-- bash "$self" --generate
