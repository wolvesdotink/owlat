#!/usr/bin/env bash
#
# CI helper: decide what actually needs to run for this event and emit the
# selections to $GITHUB_OUTPUT (falls back to stdout when run locally).
#
# Outputs:
#   packages  JSON array of {package,name,directory} for affected workspaces
#             that have a `test:coverage` task — EXCLUDING @owlat/api (sharded
#             separately, see test-api) and @owlat/desktop (never run in CI).
#   api       "true" when @owlat/api is in the affected set.
#   images    JSON array of docker-image build configs that need rebuilding.
#   java      "true" when the (non-workspace) sdk-java maven module is affected.
#
# On a full run (RUN_ALL=true — pushes, the nightly schedule, manual dispatch)
# everything is selected. Affected-only selection is a pull-request optimisation;
# the full-run safety valve means an affected-graph bug can hide a real breakage
# for at most a day rather than indefinitely.
#
# Turborepo's `--affected` walks the package dependency graph, so a change to a
# shared package automatically selects every workspace that depends on it —
# strictly better than hand-written path filters. Docker images are keyed off the
# same affected set (plus a Dockerfile-diff check for changes turbo can't see).

set -euo pipefail

RUN_ALL="${RUN_ALL:-false}"
BASE_SHA="${BASE_SHA:-}"

if [ "$RUN_ALL" = "true" ]; then
	AFFECTED_FLAG=""
	CHANGED='[]'
else
	# --affected compares HEAD against the PR base through the package graph.
	export TURBO_SCM_BASE="$BASE_SHA"
	AFFECTED_FLAG="--affected"
	CHANGED=$(git diff --name-only "$BASE_SHA...HEAD" \
		| jq -R -s -c 'split("\n") | map(select(length > 0))')
fi

# Affected workspaces with a test:coverage task. api is sharded in its own job
# and desktop never runs in CI, so both are dropped here. (turbo unions multiple
# --filter flags, so negative filters can't compose — exclude in jq instead.)
PACKAGES=$(bunx turbo run test:coverage $AFFECTED_FLAG --dry=json \
	| jq -c '[.tasks[]
			| select(.package != "@owlat/api" and .package != "@owlat/desktop")
			| {
				package: .package,
				name: (.package | sub("^@owlat/"; "")),
				directory: .directory
			}] | unique_by(.package)')

# Is @owlat/api affected? (Sharded in its own job because it dominates wall-clock.)
API=$(bunx turbo run test:coverage $AFFECTED_FLAG --filter='@owlat/api' --dry=json \
	| jq -r 'if (.tasks | length) > 0 then "true" else "false" end')

# Every affected workspace name — used to key the docker-image selection.
AFFECTED_NAMES=$(bunx turbo ls $AFFECTED_FLAG --output=json \
	| jq -c '[.packages.items[].name]')

# An image rebuilds when its workspace is affected, or (turbo can't see this) its
# Dockerfile itself changed. A full run rebuilds all of them.
if [ "$RUN_ALL" = "true" ]; then
	IMAGES=$(jq -c '.' .github/docker-images.json)
else
	IMAGES=$(jq -c --argjson aff "$AFFECTED_NAMES" --argjson chg "$CHANGED" '
		map(select(
			(.package as $p | $aff | index($p)) != null
			or (.dockerfile as $d | $chg | index($d)) != null
		))' .github/docker-images.json)
fi

# packages/sdk-java is outside the bun workspace, so turbo can't track it.
if [ "$RUN_ALL" = "true" ]; then
	JAVA=true
elif echo "$CHANGED" | jq -e 'any(.[]; startswith("packages/sdk-java/"))' >/dev/null; then
	JAVA=true
else
	JAVA=false
fi

{
	echo "packages=$PACKAGES"
	echo "api=$API"
	echo "images=$IMAGES"
	echo "java=$JAVA"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
