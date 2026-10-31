#!/usr/bin/env bash
# Requires every public **read** Convex function that reads a token-bearing
# table to run its rows through a redaction/projection helper, or to carry an
# explicit justification — the read-side data-exposure sibling of
# check-query-authz.sh.
#
# check-query-authz.sh asks "may this role SEE this table at all?"; this script
# asks the narrower question "if it may, does it strip the bearer secret before
# handing the row to the browser?". `authedQuery` / `publicQuery` serialize
# whatever the handler returns straight to the client, so a query that reads a
# token-bearing table and returns the raw `Doc` leaks a live capability — the
# H4/M8 class:
#
#   contacts    -> doiConfirmationToken / doiTokenExpiresAt
#                  (bearer for the unauthenticated POST /confirm/doi route)
#   shareLinks  -> token   (bearer for the unauthenticated /share route)
#   apiKeys     -> keyHash (the API-key verifier)
#   webhooks    -> secret  (the HMAC signing secret)
#
# A read that queries one of these four tables passes when it does ONE of:
#
#   * runs its rows through a recognized redaction/projection helper —
#       redactContactCapabilityFields / PublicContact   (contacts/listing.ts)
#       stripWebhookSecret                               (webhooks/endpoints.ts)
#     Add new per-table redactors to the helper regex below as they land.
#   * carries an explicit justification comment — inside the handler body, or on
#     the line directly above the `export const`:
#       // token-safe: <why no row-level redaction is needed here — e.g. the
#       //             handler projects to a token-free shape, returns only
#       //             counts/ids, or hands a capability to the one caller
#       //             entitled to hold it>
#
# There is no baseline. The comparison runs through `scripts/ratchet.sh
# --zero`, so any read this script reports fails CI.
#
# Scope note: the grep matches inline `.query('<table>')` scans inside a query
# span — the enumeration path where these leaks happen (getRecent,
# topics.getContacts, listShareLinks). It cannot see a row that arrives through
# an id read or a helper (`ctx.db.get(thread.contactId)`, `batchGet`,
# `getOrThrow`): a grep can neither tell which table an id points at nor whether
# the handler projected the row before returning it, so any pattern broad enough
# to catch those would also flag the reads that already project. That half is
# covered by the companion type-level gate
# convex/lib/__tests__/publicReturnRedaction.test.ts, which walks the declared
# return type of every public query, mutation and action in the generated `api`
# and fails when a capability field is reachable in it. It runs in
# `turbo typecheck`, not here.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

# `check-token-redaction.sh [root]` runs the gate, `--generate [root]` prints
# the violation set. The scan root defaults to the real convex/ tree; the vitest
# self-test (checkTokenRedaction.ratchet.test.ts) points it at throwaway
# fixture trees.
if [ "${1:-}" = "--generate" ]; then
	generate_root="${2:-convex}"
else
	generate_root=""
	scan_root="${1:-convex}"
fi

# shellcheck source=lib/convex-builders.sh
. scripts/lib/convex-builders.sh

# The scanned builders are every query builder that serializes its return value
# to the browser: the member, role and public floors (`authedQuery`,
# `adminQuery`, `publicQuery` and every `featureGated(Any)` composition such as
# `chatQuery` / `assistantQuery` / `postboxQuery`), derived from the REAL
# convex/ tree by scripts/lib/convex-builders.sh even when a fixture root is
# scanned. The shared span scanner (scripts/lib/convex-defs.awk) opens a span on
# each `export const X = <builder>(` and closes it on the column-0 `})`; this
# fragment flags a span that reads a token-bearing table (`reads`) but never
# hits a redaction helper or a `// token-safe:` comment. An admin role floor is
# not a redaction: an adminQuery that returns a raw token row still hands the
# bearer secret to the browser, so it is scanned like any other read.
generate() {
	local builders program
	builders=$(convex_builder_regex 'query' 'member|role|public') || exit 1
	program=$(convex_defs_program '
		function on_start() { reads = 0; ok = 0 }
		function on_line() {
			if ($0 ~ /\.query\((\x27|")(contacts|shareLinks|apiKeys|webhooks)(\x27|")\)/) reads = 1
			if ($0 ~ /(redactContactCapabilityFields|PublicContact|stripWebhookSecret)/) ok = 1
		}
		function on_end() { if (reads && !ok && !def_optout) print FILENAME ":" def_name }
	') || exit 1
	find "$1" -name "*.ts" \
		-not -path "*/_generated/*" \
		-not -path "*/__tests__/*" \
		-print0 \
		| xargs -0 -r awk -v builders="$builders" -v optout='token-safe' "$program" \
		| sort
}

if [ -n "$generate_root" ]; then
	generate "$generate_root"
	exit 0
fi

exec "$repo_root/scripts/ratchet.sh" \
	--zero \
	--ok "every token-bearing read redacts or justifies its rows" \
	--new-header "FAIL: {n} read(s) returning a token-bearing table with no redaction." \
	--new-advice "A public read that queries contacts / shareLinks / apiKeys / webhooks
serializes the row — including its bearer secret — straight to the client.
  - run the rows through redactContactCapabilityFields / stripWebhookSecret
    (or add a new per-table redactor to the helper regex in this script), or
  - add a '// token-safe: <reason>' comment stating why no row-level
    redaction is needed (projects to a token-free shape / counts / ids /
    a capability the caller is entitled to receive)." \
	-- bash "$self" --generate "$scan_root"
