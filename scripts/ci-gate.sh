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
	lint)
		turbo_tasks=(lint)
		turbo_concurrency_args=()
		;;
	verify)
		turbo_tasks=(lint typecheck test)
		# A cold full-workspace verify gives every test runner its own worker pool.
		# Bound the number of simultaneous Turbo tasks so those pools do not starve
		# one another. CI can keep its runner-specific lower override.
		turbo_concurrency_args=(--concurrency="${TURBO_CONCURRENCY:-4}")
		;;
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

step bunx turbo "${turbo_tasks[@]}" "${turbo_concurrency_args[@]}" --filter='!@owlat/desktop'

# script-tests is the single vitest boot for scripts/__tests__ — the unit tests
# for the gate scripts themselves. It used to be a `vitest run <file>` prefix
# inside each lint:* entry, which booted vitest once per gate and left the
# test files without a matching lint:* entry running only in security.yml.
for gate in scripts script-tests deadcode build-graph convex-orphans convex-globals filesize adr branding format imports providers \
	ui-buttons tokens member-jargon docker-workspaces deploy-closure installer compose; do
	step bun run "lint:$gate"
done
# lint:plugin-imports without its plugins:prepare prefix (see above).
step bun packages/plugin-codegen/src/cli.ts --boundaries-only
