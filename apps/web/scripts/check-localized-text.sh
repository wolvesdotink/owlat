#!/usr/bin/env bash
# Copy a pure module hands to its renderer has one shape and one resolver:
# `LocalizedText` and `resolveLocalized` in app/utils/localizedText.ts, bound to
# a component by `useLocalized()`. The union used to be restated in some thirty
# files and the resolver pasted into sixty, and two of the copies had already
# drifted apart on what an already-worded string does.
#
# The generator prints one `path:<spelling>` line per occurrence under app/ and
# server/, outside app/utils/localizedText.ts and tests:
#   type LocalizedText =                              → import the type
#   interface LocalizedText                           → pick another name (the
#                                                       conditions registry's is
#                                                       ConditionLabelKey)
#   string | { key: string; params?: Record<string, unknown> }
#                                                     → import LocalizedText (a
#                                                       domain alias is fine:
#                                                       `type BriefText = LocalizedText`)
#   params ?? {})                                     → useLocalized() / resolveLocalized
#
# RATCHET on scripts/ratchet.sh, strict in both directions. The baseline
# (scripts/localized-text-baseline.txt) lists only files that a parallel rewrite
# owned when the helper landed; migrate them and delete their lines.

set -uo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

generate() {
	[ -d app ] && [ -d server ] || {
		echo "check-localized-text: app/ or server/ missing — run from apps/web" >&2
		return 1
	}
	find app server \( -name "*.ts" -o -name "*.vue" \) \
		-not -path "*/__tests__/*" \
		! -name "*.test.ts" \
		! -path "app/utils/localizedText.ts" \
		-print0 | LC_ALL=C sort -z | xargs -0 awk '
			# Prose may name the spellings; only code is flagged.
			/^[[:space:]]*(\/\/|\*|\/\*)/ { next }
			/type LocalizedText =/ { print FILENAME ":type LocalizedText =" }
			/interface LocalizedText[[:space:]{<]/ { print FILENAME ":interface LocalizedText" }
			index($0, "string | { key: string; params?: Record<string, unknown> }") {
				print FILENAME ":string | { key, params } union"
			}
			index($0, "params ?? {})") { print FILENAME ":params ?? {})" }
		' | LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec "$repo_root/scripts/ratchet.sh" \
	--baseline scripts/localized-text-baseline.txt \
	--seed "bash apps/web/scripts/check-localized-text.sh --write-baseline" \
	--ok "no module restates LocalizedText or its resolver outside app/utils/localizedText.ts" \
	--new-header "FAIL: {n} copy/copies of LocalizedText or its resolver outside app/utils/localizedText.ts:" \
	--new-advice "Use the shared module instead:
  type LocalizedText = …            → import type { LocalizedText } from '~/utils/localizedText'
  string | { key; params } union    → the same import (a domain alias may be \`= LocalizedText\`)
  typeof v === 'string' ? t(v) : t(v.key, v.params ?? {})
                                    → const localized = useLocalized(); localized(v)
                                      (resolveLocalized({ t, te }, v) outside a component)
Do NOT add lines to {baseline}; it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (file migrated or removed):" \
	"$@" \
	-- bash "$self" --generate
