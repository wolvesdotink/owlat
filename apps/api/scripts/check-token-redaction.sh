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
#       //             counts/ids, or is held to an admin role gate>
#   * is listed in scripts/token-redaction-baseline.txt — the frozen set of
#     reads reviewed at the time this gate landed (P4 already fixed the real
#     leaks; the baseline entries are the count-only / id-only / field-projected
#     / admin-gated reads that return no bearer token). Like check-query-authz.sh
#     this is a RATCHET, not a baseline-0 hard gate.
#
# The ratchet is strict in both directions: an unlisted read fails (a NEW query
# returning a token-bearing table with no redaction), and a stale baseline entry
# fails (the query was fixed/removed/annotated — delete its line so the count
# only goes down).
#
# Scope note: the grep matches inline `.query('<table>')` scans inside a query
# span — the enumeration path where these leaks happen (getRecent,
# topics.getContacts, listShareLinks). A read that fetches a single row by id in
# a shared helper is out of scope for this conservative gate; check-query-authz.sh
# and code review remain the backstop for those.

cd "$(dirname "$0")/.."

# Optional overrides let the vitest self-test (checkTokenRedaction.ratchet.test.ts)
# point the scan and the baseline at a throwaway fixture tree; production runs
# take the defaults (the real convex/ tree and the frozen baseline).
scan_root="${1:-convex}"
baseline_file="${2:-scripts/token-redaction-baseline.txt}"

# awk walks each file (NR resets per file via find -exec ... {} \;). It tracks
# the span of each `export const X = authedQuery(`/`publicQuery(` definition —
# from the export line to the dedented `})` that closes it (top-level defs sit at
# column 0; everything inside the handler is indented, so the only column-0 `})`
# is the definition's own close). A span is flagged when it reads a token-bearing
# table (`reads`) but never hits a redaction helper or a `// token-safe:` comment
# (`ok`). `block_optout` lets a `// token-safe:` note sit in the contiguous `//`
# block directly above the export; it is reset by any non-comment, non-export
# line so it can never leak onto an unrelated later definition.
violations=$(find "$scan_root" -name "*.ts" \
	-not -path "*/_generated/*" \
	-not -path "*/__tests__/*" \
	-exec awk '
		BEGIN { in_fn = 0; reads = 0; ok = 0; name = ""; block_optout = 0 }
		{
			is_comment = ($0 ~ /^[[:space:]]*\/\//)
			is_just    = ($0 ~ /\/\/[[:space:]]*token-safe:/)
			is_export  = ($0 ~ /^export const [A-Za-z0-9_]+ = (authedQuery|publicQuery)\(/)
			is_read    = ($0 ~ /\.query\((\x27|")(contacts|shareLinks|apiKeys|webhooks)(\x27|")\)/)
			is_redact  = ($0 ~ /(redactContactCapabilityFields|PublicContact|stripWebhookSecret)/)
		}
		is_comment && is_just { block_optout = 1 }
		is_export {
			in_fn = 1; name = $3; reads = 0
			ok = block_optout
			block_optout = 0
		}
		in_fn && is_read   { reads = 1 }
		in_fn && is_redact { ok = 1 }
		in_fn && is_just   { ok = 1 }
		in_fn && /^\}\)/ {
			if (reads && !ok) print FILENAME ":" name
			in_fn = 0
		}
		(!is_comment && !is_export) { block_optout = 0 }
	' {} \; 2>/dev/null | sort || true)

new=$(comm -23 <(printf '%s\n' "$violations" | grep . || true) <(sort "$baseline_file"))
stale=$(comm -13 <(printf '%s\n' "$violations" | grep . || true) <(sort "$baseline_file"))

fail=0
if [ -n "$new" ]; then
	count=$(printf '%s\n' "$new" | grep -c .)
	echo "FAIL: $count new read(s) returning a token-bearing table with no redaction."
	echo ""
	echo "$new"
	echo ""
	echo "A public read that queries contacts / shareLinks / apiKeys / webhooks"
	echo "serializes the row — including its bearer secret — straight to the client."
	echo "  - run the rows through redactContactCapabilityFields / stripWebhookSecret"
	echo "    (or add a new per-table redactor to the helper regex in this script), or"
	echo "  - add a '// token-safe: <reason>' comment stating why no row-level"
	echo "    redaction is needed (projects to a token-free shape / counts / ids /"
	echo "    admin role gate)."
	echo "Do NOT add new entries to $baseline_file — it is frozen debt."
	fail=1
fi
if [ -n "$stale" ]; then
	count=$(printf '%s\n' "$stale" | grep -c .)
	echo "FAIL: $count stale entr(y/ies) in $baseline_file (read fixed, removed, or annotated):"
	echo ""
	echo "$stale"
	echo ""
	echo "Delete these lines so the ratchet only moves down."
	fail=1
fi
[ "$fail" -eq 1 ] && exit 1

baseline_count=$(grep -c . "$baseline_file")
echo "ok:   no new token-bearing read without redaction ($baseline_count baseline entries remain)"
