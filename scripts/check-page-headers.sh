#!/usr/bin/env bash
#
# Page-header ratchet (#865). packages/ui's UiPageHeader is the one page
# header: the h1 at the app's title scale, a lead capped at the 540px measure,
# and an #actions row that wraps at 375px. Before it existed every page
# hand-rolled the same block — an `<h1 class="text-2xl font-medium
# tracking-[-0.02em] …">`, a secondary paragraph and a flex row of buttons —
# and each copy drifted on its own (uncapped leads, actions pushed off a
# phone's edge). A new page copies whichever neighbour it opens first, so
# without a gate the hand-rolled count only grows.
#
# The generator lists every .vue file under apps/web/app with an <h1> tag that
# carries that class string, one path per line, sorted. Only the h1 is matched:
# the same classes on a <p> or <span> are a stat value (a metric card's
# number), not a page header, and UiPageHeader is no answer for those. The tag
# may span several lines; its attributes are read up to the closing `>`.
#
# scripts/ratchet.sh runs the comparison against
# scripts/page-header-baseline.txt, strict in BOTH directions like every other
# baseline here: a new file with a hand-rolled h1 fails (use UiPageHeader, do
# not add a line), and a listed file that moved to UiPageHeader fails as stale
# (delete the line, so the list only shrinks).

set -uo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

generate() {
	if [ ! -d apps/web/app ]; then
		echo "FAIL: apps/web/app not found; run from the repository root." >&2
		exit 1
	fi
	find apps/web/app \
		\( -path '*/node_modules' -o -path '*/.nuxt' -o -path '*/.output' \) -prune -o \
		-type f -name '*.vue' -print0 2>/dev/null \
		| xargs -0 -r perl -0777 -ne \
			'print "$ARGV\n" if /<h1\b[^>]*?text-2xl font-medium tracking-\[-0\.02em\]/s' \
		| LC_ALL=C sort
}

if [ "${1:-}" = "--generate" ]; then
	generate
	exit $?
fi

exec scripts/ratchet.sh \
	--baseline scripts/page-header-baseline.txt \
	--seed "bash scripts/check-page-headers.sh --write-baseline" \
	--ok "no new hand-rolled page headers" \
	--new-header "FAIL: {n} file(s) hand-roll a page header h1 and are not in {baseline}:" \
	--new-advice "Render the header with <UiPageHeader :title :description> and put the
page's buttons in its #actions slot. Do NOT add a new line to {baseline};
it is frozen debt." \
	--stale-header "FAIL: {n} stale entr(y/ies) in {baseline} (header migrated or file removed):" \
	--stale-advice "Delete these lines so the list only shrinks." \
	"$@" \
	-- bash "$self" --generate
