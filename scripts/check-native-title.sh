#!/usr/bin/env bash
#
# Native-title ratchet. A `title` on a control is a tooltip that never shows on
# keyboard focus or touch; controls get UiTooltip
# (packages/ui/components/ui/Tooltip.vue) instead. scripts/native-title-findings.ts
# lists every `title` / `:title` left on an interactive element in the Vue
# templates (what counts as interactive, and how a title that really is
# metadata is kept, is documented there), and scripts/ratchet.sh compares the
# list against scripts/native-title-baseline.txt, strict in both directions:
# a new site fails (wrap the control in UiTooltip, do not add a line), and a
# baseline line nothing reports any more fails as stale (delete it).

set -uo pipefail
cd "$(dirname "$0")/.."

exec scripts/ratchet.sh \
	--baseline scripts/native-title-baseline.txt \
	--seed "bash scripts/check-native-title.sh --write-baseline" \
	--ok "no new native title tooltips" \
	--new-header "FAIL: {n} native title tooltip(s) on controls not in {baseline}:" \
	--new-advice "Wrap the control in <UiTooltip :text=\"…\"> (and give an icon-only control its own aria-label) instead of a title attribute. Do NOT add new lines to {baseline}; it is frozen debt." \
	"$@" \
	-- bun scripts/native-title-findings.ts
