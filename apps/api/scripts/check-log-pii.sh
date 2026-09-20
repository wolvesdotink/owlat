#!/usr/bin/env bash
# Keep correspondent addresses and message subjects out of the PROCESS log.
#
# Convex's function log is not the product. It is shipped to whatever aggregator
# the operator points at, read by people who hold no mail-content grant, and it
# outlives the message it describes. A line like
#
#   logWarn('[Inbound Email] duplicate delivery', { from: args.from, subject: args.subject })
#
# puts a correspondent's address and a user-written subject into that pipe
# forever, for a decision that only needed the lines to line up. Route the value
# through the @owlat/shared/logRedaction helpers instead: they keep the domain
# and a stable digest, so two lines about the same recipient still correlate
# while the plaintext never lands.
#
# Scope: process logs only. Rows written to `auditLogs`, delivery-log tables, or
# anything else persisted deliberately and shown in the UI are a different
# question with a different answer, and this gate never looks at them — it only
# reads the argument list of a log CALL.
#
# Like check-body-access.sh this is a build gate with a BASELINE OF ZERO: the
# sweep that landed it fixed every site, so a single violation fails. There is
# no baseline file to grow.
#
# What fails: an object-literal key named
#
#   from | to | subject | email | recipient | rcptTo | mailFrom | address | sender
#
# inside a `logInfo` / `logWarn` / `logError` / `logDebug` / `console.*` call,
# whose value does not pass through `redactEmailAddress` / `redactEmailAddresses`
# / `redactSubject` / `redactionDigest` on the same line.
#
# What does not fail, by construction: the key match is exact, so `fromDomain`,
# `toCount`, `senderId`, `recipientHash`, `addressCount` and every other
# qualified name is out of scope — a domain, a count, an id or a digest is not
# the address. Interpolated strings (`` `sent to ${to}` ``) are also out of
# scope: this gate reads keys, not template holes, and code review plus the
# helpers remain the backstop there.
#
# Opt-out, for a key that is genuinely not a correspondent address (a header
# name, a webhook field, an internal routing label):
#
#   // log-pii-safe: <why this value is not a correspondent address or subject>
#
# inside the call, or in the contiguous comment block directly above it.
#
# Optional first arg overrides the scan root (default `convex`) so the self-test
# (convex/lib/__tests__/checkLogPii.gate.test.ts) can point it at a fixture tree.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

root="${1:-convex}"

# awk walks each file (NR resets per file via find -exec ... {} \;) and tracks
# the span of a log call: it opens on a `logX(` / `console.x(` line and closes on
# the line whose text ends the argument list. `span` caps a run-on at 20 lines so
# an unclosed call can never bleed a `to:` key from unrelated code below it.
# `block_optout` lets the justification sit in the comment block directly above
# the call; any other non-comment line clears it, so it cannot leak forward.
violations=$(
	find "$root" -name '*.ts' \
		-not -path '*/_generated/*' \
		-not -path '*/__tests__/*' \
		! -name '*.test.ts' \
		-exec awk '
			BEGIN { in_call = 0; span = 0; optout = 0; block_optout = 0 }
			{
				is_comment = ($0 ~ /^[[:space:]]*\/\//)
				is_just    = ($0 ~ /\/\/[[:space:]]*log-pii-safe:/)
				is_open    = ($0 ~ /(logInfo|logWarn|logError|logDebug|console\.(log|info|warn|error|debug))\(/)
				is_key     = ($0 ~ /(^|[{,[:space:]])(from|to|subject|email|recipient|rcptTo|mailFrom|address|sender)[[:space:]]*:/)
				is_redact  = ($0 ~ /redact(EmailAddress|EmailAddresses|Subject|ionDigest)/)
				is_close   = ($0 ~ /\)[[:space:]]*;?[[:space:]]*$/)
			}
			is_comment && is_just { block_optout = 1 }
			is_open && !in_call {
				in_call = 1; span = 0
				optout = block_optout
				block_optout = 0
			}
			in_call && is_just { optout = 1 }
			in_call && is_key && !is_redact && !optout {
				sub(/^[[:space:]]+/, "")
				print FILENAME ":" FNR ": " $0
			}
			in_call {
				span++
				if (is_close || span >= 20) in_call = 0
			}
			(!is_comment && !is_open) { block_optout = 0 }
		' {} \; 2>/dev/null | sort
)

if [ -n "$violations" ]; then
	count=$(printf '%s\n' "$violations" | grep -c .)
	echo "FAIL: $count log call(s) writing a correspondent address or subject to the process log:"
	echo ""
	printf '%s\n' "$violations"
	echo ""
	echo "Process logs are shipped off-box and read without a mail-content grant."
	echo "Redact the value instead of dropping the field:"
	echo "  import { redactEmailAddress, redactSubject } from '@owlat/shared/logRedaction';"
	echo "  logWarn('...', { from: redactEmailAddress(args.from), subject: redactSubject(args.subject) });"
	echo ""
	echo "The redacted form keeps the domain and a stable digest, so lines about the"
	echo "same correspondent still correlate across services and restarts."
	echo ""
	echo "If the value is genuinely not a correspondent address or subject, say so:"
	echo "  // log-pii-safe: <reason>"
	exit 1
fi

echo "OK: no address or subject fields in process-log calls"
