#!/usr/bin/env bash
#
# check-dmarc-docs.sh
#
# The DMARC row of the "DNS Records Generated" table in the developer
# email-system guide must document what buildDmarcRecordValue emits by default:
# `v=DMARC1; p=none`, with no `rua=` unless the operator sets MTA_DMARC_RUA and
# never a synthesised dmarc@<customer-domain> mailbox (regression for PR-67).
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

doc=../docs/content/en/3.developer/6.email-system.md
if [ ! -f "$doc" ]; then
	echo "check-dmarc-docs: $doc not found" >&2
	exit 1
fi

row=$(grep -E '^\|[[:space:]]*DMARC[[:space:]]*\|' "$doc" | head -n 1)
if [ -z "$row" ]; then
	echo "FAIL: no DMARC row in the DNS records table of $doc" >&2
	exit 1
fi
if printf '%s' "$row" | grep -qF 'rua=mailto:dmarc@'; then
	echo "FAIL: $doc documents a synthesised dmarc@{domain} reporting mailbox the code never emits" >&2
	exit 1
fi
if ! printf '%s' "$row" | grep -qF 'v=DMARC1; p=none'; then
	echo "FAIL: the DMARC row of $doc no longer shows the omit-by-default value 'v=DMARC1; p=none'" >&2
	exit 1
fi
echo "check-dmarc-docs: OK"
