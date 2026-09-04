#!/usr/bin/env bash
# The one lint/verify gate. `bun run ci:lint` (test.yml, every PR) and
# `bun run ci:verify` (_verify.yml, every release tag) both run this file, so a
# gate added here fires in both places and the two chains cannot drift apart.
#
#   bash scripts/ci-gate.sh lint     plugin smokes + turbo lint + the ratchets
#   bash scripts/ci-gate.sh verify   the same, with turbo typecheck and test
#
# The plugin smokes are ordered so provider-kit and plugin-kit are built ONCE.
# The first smoke deletes packages/plugin-kit/dist and proves the API tests do
# not rebuild it; `plugins:test-clean` then deletes it again and runs
# `plugins:check`, whose `plugins:prepare` is the single build of the run. The
# smokes after that need the dist, so they call their scripts directly instead
# of the package.json entries, which each prepend another `plugins:prepare` so
# they also work standalone.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
	lint) turbo_tasks=(lint) ;;
	verify) turbo_tasks=(lint typecheck test) ;;
	*)
		echo "usage: bash scripts/ci-gate.sh lint|verify" >&2
		exit 2
		;;
esac

step() {
	echo
	echo "== ci-gate: $*"
	"$@"
}

step bun run plugins:test-api-graph
step bun run plugins:test-deploy-graph
step bun run plugins:test-clean
step node packages/plugin-codegen/scripts/convexBundleSmoke.ts
step bun packages/plugin-codegen/scripts/convexFunctionGraphSmoke.ts

step bunx turbo "${turbo_tasks[@]}" --filter='!@owlat/desktop'

for gate in deadcode build-graph convex-orphans filesize adr branding format imports providers \
	ui-buttons tokens member-jargon docker-workspaces release-compose deploy-closure; do
	step bun run "lint:$gate"
done
# lint:plugin-imports without its plugins:prepare prefix (see above).
step bun packages/plugin-codegen/src/cli.ts --boundaries-only
