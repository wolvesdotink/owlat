#!/usr/bin/env bash
#
# Native-title gate. A `title` on a control is a tooltip that never shows on
# keyboard focus or touch; controls get UiTooltip
# (packages/ui/components/ui/Tooltip.vue) instead. scripts/native-title-findings.ts
# lists every `title` / `:title` left on an interactive element in the Vue
# templates (what counts as interactive, and how a title that really is
# metadata is kept, is documented there), and scripts/ratchet.sh --zero fails
# on any of them: the debt is gone, so there is no baseline to add a site to.

set -uo pipefail
cd "$(dirname "$0")/.."

exec scripts/ratchet.sh \
	--zero \
	--ok "no native title tooltips" \
	--new-header "FAIL: {n} native title tooltip(s) on controls:" \
	--new-advice "Wrap the control in <UiTooltip :text=\"…\"> (and give an icon-only control its own aria-label) instead of a title attribute. A title that really is metadata (the full value of truncated link text) is kept by a <!-- native-title: <why> --> comment right before the element." \
	"$@" \
	-- bun scripts/native-title-findings.ts
