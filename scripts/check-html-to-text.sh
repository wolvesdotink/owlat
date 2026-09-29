#!/usr/bin/env bash
# HTML → plain text has one home: `htmlToPlainText` in
# packages/mail-message/src/text/htmlToPlainText.ts, re-exported for API and web
# code as `@owlat/shared/html`. About ten private strippers used to turn the same
# message into different text per feature: some kept `<script>` bodies, one put
# `<style>` CSS into the Sent-copy snippet, and each decoded its own handful of
# entities. The shared pass drops script, style, head and comments, decodes
# named and numeric entities, and stays linear on hostile input, which a bare
# `<[^>]+>` retried from every `<` does not.
#
# The generator prints `path:<spelling>` for every hand-rolled tag strip under
# apps/api/convex, packages/shared/src and packages/mail-message/src, outside
# the helper itself, tests and generated code:
#   .replace(/<[^>]+>/g …    → htmlToPlainText(html)
#   .replace(/<[^>]*>/g …    → htmlToPlainText(html)
#
# RATCHET on scripts/ratchet.sh, strict in both directions. The baseline
# (scripts/html-to-text-baseline.txt) may only list a strip whose output is NOT
# text for a reader, a model or an index (markup rewriting, say), with its
# reason. A new entry means a module rolled its own HTML→text: import
# `htmlToPlainText` from `@owlat/shared/html` (or from
# `@owlat/mail-message/text/htmlToPlainText` inside mail-message). A stale entry
# means a listed site went away: delete its line.

set -uo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

SCOPES=(apps/api/convex packages/shared/src packages/mail-message/src)
HELPER=packages/mail-message/src/text/htmlToPlainText.ts

generate() {
	for scope in "${SCOPES[@]}"; do
		[ -d "$scope" ] || {
			echo "check-html-to-text: $scope missing — run from the repository root" >&2
			return 1
		}
	done
	find "${SCOPES[@]}" -name "*.ts" \
		-not -path "*/_generated/*" \
		-not -path "*/__tests__/*" \
		! -name "*.test.ts" \
		! -path "$HELPER" \
		-exec awk '
			# Prose may name the spellings; only code is flagged.
			/^[[:space:]]*(\/\/|\*|\/\*)/ { next }
			index($0, ".replace(/<[^>]+>/g") { print FILENAME ":.replace(/<[^>]+>/g" }
			index($0, ".replace(/<[^>]*>/g") { print FILENAME ":.replace(/<[^>]*>/g" }
		' {} + | LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec bash scripts/ratchet.sh \
	--baseline scripts/html-to-text-baseline.txt \
	--seed "bash scripts/check-html-to-text.sh --write-baseline" \
	--ok "no module rolls its own HTML-to-text strip" \
	--new-header "FAIL: {n} hand-rolled HTML tag strip(s) outside htmlToPlainText:" \
	--new-advice "Use the shared pass instead of a private regex:
  import { htmlToPlainText } from '@owlat/shared/html';
  htmlToPlainText(html)                           one line, whitespace collapsed
  htmlToPlainText(html, { preserveBreaks: true }) paragraphs and line breaks kept
It drops script, style, head and comments and decodes entities. Only a strip
whose output is not text (markup rewriting, say) may be listed in {baseline},
with its reason." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (site converted or removed):" \
	"$@" \
	-- bash "$self" --generate
