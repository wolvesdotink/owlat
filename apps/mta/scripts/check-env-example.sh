#!/usr/bin/env bash
#
# Every environment variable the MTA reads must be documented in .env.example.
# Keys are read directly in config.ts (requiredEnv / optionalEnv / process.env)
# and indirectly in governedDeliveryConfig.ts, which hands optionalEnv to
# loadGovernedCapacity together with the key name — so both files are scanned.

set -uo pipefail
cd "$(dirname "$0")/.."

read_keys=$(cat src/config.ts src/governedDeliveryConfig.ts | tr '\n' ' ' \
	| grep -oE "(requiredEnv|optionalEnv)\('[A-Z][A-Z0-9_]+'|process\.env\['[A-Z][A-Z0-9_]+'\]|loadGovernedCapacity\(\s*optionalEnv,\s*'[A-Z][A-Z0-9_]+'" \
	| grep -oE "'[A-Z][A-Z0-9_]+'" | tr -d "'" | sort -u)
documented=$(grep -oE '^\s*#?\s*[A-Z][A-Z0-9_]+=' .env.example | grep -oE '[A-Z][A-Z0-9_]+' | sort -u)

missing=$(comm -23 <(printf '%s\n' "$read_keys") <(printf '%s\n' "$documented"))
if [ -n "$missing" ]; then
	echo "check-env-example: env vars read by the MTA but missing from apps/mta/.env.example:" >&2
	printf '%s\n' "$missing" | sed 's/^/    + /' >&2
	exit 1
fi
echo "ok:   every env var the MTA reads is documented in .env.example ($(printf '%s\n' "$read_keys" | grep -c .) keys)"
