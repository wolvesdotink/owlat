#!/usr/bin/env bash
#
# check-env-keys-sync.sh
#
# Asserts the setup-CLI's CONVEX_RUNTIME_ENV_KEYS push list stays in sync with
# the EnvKey union (the single source of truth) in apps/api/convex/lib/env.ts.
#
# The setup CLI uses CONVEX_RUNTIME_ENV_KEYS to decide which `.env` keys to push
# into the Convex deployment via `convex env set`. If a function-runtime env var
# is added to EnvKey but not to that list, a self-hoster who sets it would find
# it silently never reaches the backend (the feature stays off with no error).
#
# CONVEX_SITE_URL is a Convex BUILT-IN (the backend derives it and `convex env
# set` rejects overriding it), so it is intentionally excluded from the push
# list — this guard accounts for that.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_TS="$ROOT/apps/api/convex/lib/env.ts"
# CONVEX_RUNTIME_ENV_KEYS is the shared SSOT (re-exported by convexDeploy.ts).
DEPLOY_TS="$ROOT/packages/shared/src/convexRuntimeEnv.ts"
BUILTIN="CONVEX_SITE_URL"

# Extract single-quoted UPPER_SNAKE tokens, with // line comments stripped first
# (a comment in convexDeploy.ts literally quotes 'CONVEX_SITE_URL').
extract() {
	sed 's://.*::' | grep -oE "'[A-Z][A-Z0-9_]+'" | tr -d "'" | sort -u
}

# EnvKey union members: from `export type EnvKey =` to the terminating `;`.
envkeys=$(awk '/export type EnvKey =/{f=1} f{print} f&&/;[[:space:]]*$/{exit}' "$ENV_TS" | extract)

# Runtime push list members: from `CONVEX_RUNTIME_ENV_KEYS = [` to `] as const;`.
runtime=$(awk '/CONVEX_RUNTIME_ENV_KEYS = \[/{f=1} f{print} f&&/\] as const;/{exit}' "$DEPLOY_TS" | extract)

# Expected push list = EnvKey minus the Convex built-in.
expected=$(printf '%s\n' "$envkeys" | grep -vx "$BUILTIN" | sort -u)

if [ "$runtime" != "$expected" ]; then
	echo "check-env-keys-sync: CONVEX_RUNTIME_ENV_KEYS is out of sync with EnvKey." >&2
	missing=$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$runtime") || true)
	extra=$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$runtime") || true)
	[ -n "$missing" ] && { echo "  In EnvKey but missing from the push list:" >&2; printf '%s\n' "$missing" | sed 's/^/    + /' >&2; }
	[ -n "$extra" ] && { echo "  In the push list but not in EnvKey:" >&2; printf '%s\n' "$extra" | sed 's/^/    - /' >&2; }
	echo "  Fix packages/shared/src/convexRuntimeEnv.ts (or apps/api/convex/lib/env.ts)." >&2
	exit 1
fi

echo "ok:   CONVEX_RUNTIME_ENV_KEYS in sync with EnvKey ($(printf '%s\n' "$runtime" | grep -c . ) keys)"
