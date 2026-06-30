#!/usr/bin/env bash
#
# check-env-docs.sh
#
# Asserts every member of the EnvKey union (the single source of truth for which
# environment variables the Convex backend reads, in convex/lib/env.ts) is
# documented in the environment-variables reference. Keeps the docs provably in
# sync with the code instead of hand-maintained — a new EnvKey can't ship
# undocumented (which is how RATE_LIMIT_TRUSTED_PROXY, GITHUB_WEBHOOK_SECRET,
# OPENROUTER_API_KEY and LLM_COMPLEXITY_ROUTING previously drifted out).
#
set -euo pipefail
cd "$(dirname "$0")/.." # apps/api

ENV_TS="convex/lib/env.ts"
DOC="../docs/content/3.developer/8.environment-variables.md"

if [ ! -f "$DOC" ]; then
	echo "check-env-docs: doc not found at $DOC" >&2
	exit 1
fi

# EnvKey union members: from `export type EnvKey =` to the terminating `;`, with
# // comments stripped so a quoted token in a comment isn't mistaken for a member.
keys=$(awk '/export type EnvKey =/{f=1} f{print} f&&/;[[:space:]]*$/{exit}' "$ENV_TS" \
	| sed 's://.*::' | grep -oE "'[A-Z][A-Z0-9_]+'" | tr -d "'" | sort -u)

missing=0
while IFS= read -r key; do
	[ -z "$key" ] && continue
	# Whole-word match so e.g. SITE_URL isn't satisfied by ADMIN_SITE_URL.
	if ! grep -qE "(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)" "$DOC"; then
		echo "  missing from environment-variables.md: $key"
		missing=$((missing + 1))
	fi
done <<EOF
$keys
EOF

if [ "$missing" -gt 0 ]; then
	echo "FAIL: $missing EnvKey var(s) not documented in $DOC."
	echo "      Document them in the env-vars reference (apps/docs)."
	exit 1
fi

echo "ok:   every EnvKey is documented in environment-variables.md ($(printf '%s\n' "$keys" | grep -c .) keys)"
