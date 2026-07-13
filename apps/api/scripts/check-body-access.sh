#!/usr/bin/env bash
# Enforce the single message-body accessor (lib/messageBody.ts). A message body
# lives in one of three shapes — inboundMessages inline `textBody`/`htmlBody`,
# mailMessages inline `textBodyInline`/`htmlBodyInline` (or a `*BodyStorageId`
# blob), unifiedMessages `content` JSON — and every STORED-ROW read of a body
# must go through lib/messageBody.ts so that Sealed Mail's "unseal on read" hook
# (E8b) has one choke point instead of ~30 scattered field accesses.
#
# Like check-boolean-naming.sh / check-errors.sh this is a build gate, but with a
# BASELINE OF ZERO from day one (piece E8a migrated every reader): a single
# violation fails the build. There is no baseline file to grow.
#
# Two forbidden patterns, scoped to apps/api/convex/ source:
#
#   1. A dot-read of a body-content field —
#      `<recv>.textBody` / `.htmlBody` / `.textBodyInline` / `.htmlBodyInline` —
#      where <recv> is NOT a validated call argument / wire-payload receiver.
#      Object-literal KEYS (`textBody: …`) are writes, not reads, and never
#      match (the pattern requires a leading `.`). Reads off `args.`, `params.`,
#      `input.`, or `mp.` are excluded: those are mutation arguments, pure guard
#      parameters, or MailParser output — the ingest/write boundary, not a stored
#      row. `*BodyStorageId` is excluded (it is a storage handle, not body text).
#
#   2. A body-blob CONTENT read — `storage.get(<x>.textBodyStorageId)` /
#      `...htmlBodyStorageId` — anywhere but lib/messageBody.ts. Turning a body
#      blob id into bytes is exactly what `readMailMessageText` owns.
#
# Excluded paths: _generated, __tests__, *.test.ts, schema/ (type declarations,
# not reads), lib/messageBody.ts (the accessor itself), and webhooks/dispatcher.ts
# (the webhook-event dispatcher — its `e.mail` payload is wire input translated
# straight into a mutation call, never a stored DB row).
#
# Optional first arg overrides the scan root (default `convex`) so the self-test
# can point it at a fixture tree.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

root="${1:-convex}"
fields='textBody|htmlBody|textBodyInline|htmlBodyInline'
allowed='args|params|input|mp'

# Files to scan: *.ts under the root, minus generated/tests/schema/self/dispatcher.
# A plain newline-delimited loop (not `mapfile`) so this runs on macOS bash 3.2.
files=$(
	find "$root" -name '*.ts' \
		-not -path '*/_generated/*' \
		-not -path '*/__tests__/*' \
		! -name '*.test.ts' \
		-not -path '*/schema/*' \
		-not -path '*/lib/messageBody.ts' \
		-not -path '*/webhooks/dispatcher.ts' \
		2>/dev/null | sort
)

fail=0

# ── Pattern 1: stored-row body-field dot-reads ───────────────────────────────
read_violations=""
while IFS= read -r f; do
	[ -n "$f" ] || continue
	while IFS= read -r hit; do
		ln="${hit%%:*}"
		content="${hit#*:}"
		# Remove the allowed-receiver reads, then see if any body-field dot-read
		# survives. This is per-occurrence, so a line mixing an allowed read and a
		# real one is still caught.
		stripped=$(printf '%s' "$content" | perl -pe "s/\b(${allowed})\.(${fields})\b//g")
		if printf '%s' "$stripped" | grep -qE "\.(${fields})\b"; then
			read_violations="${read_violations}${f}:${ln}:${content}"$'\n'
		fi
	done < <(grep -nE "\.(${fields})\b" "$f" 2>/dev/null || true)
done < <(printf '%s\n' "$files")

if [ -n "$read_violations" ]; then
	count=$(printf '%s' "$read_violations" | grep -c .)
	echo "FAIL: $count direct message-body read(s) outside lib/messageBody.ts:"
	echo ""
	printf '%s' "$read_violations"
	echo ""
	echo "Read the body through lib/messageBody.ts instead:"
	echo "  inboundMessages inline  -> inboundMessageBody(row).text / .html"
	echo "  mailMessages inline     -> mailMessageInlineBody(row).text / .html"
	echo "  mailMessages inline+blob-> await readMailMessageText(ctx.storage, row)"
	echo "  unifiedMessages.content -> parseUnifiedMessageContent(row.content)"
	fail=1
fi

# ── Pattern 2: body-blob CONTENT reads ───────────────────────────────────────
blob_violations=$(
	grep -rnE 'storage\.get\([^)]*(textBodyStorageId|htmlBodyStorageId)' "$root" --include='*.ts' 2>/dev/null \
		| grep -v '/_generated/' \
		| grep -v '/__tests__/' \
		| grep -v '\.test\.ts:' \
		| grep -v '/lib/messageBody.ts:' \
		|| true
)
if [ -n "$blob_violations" ]; then
	count=$(printf '%s\n' "$blob_violations" | grep -c .)
	echo "FAIL: $count body-blob content read(s) outside lib/messageBody.ts:"
	echo ""
	echo "$blob_violations"
	echo ""
	echo "Resolve a body blob via readMailMessageText(ctx.storage, row) so the one"
	echo "place that turns a body-storage id into bytes stays inside the accessor."
	fail=1
fi

[ "$fail" -eq 1 ] && exit 1

echo "ok:   message bodies read only through lib/messageBody.ts (baseline 0)"
