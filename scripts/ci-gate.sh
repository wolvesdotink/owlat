#!/usr/bin/env bash
# The one lint/verify gate. `bun run ci:lint` (test.yml, every PR) and
# the local `bun run ci:verify` both run this file, so a
# gate added here fires in both places and the two chains cannot drift apart.
#
#   bash scripts/ci-gate.sh lint     plugin smokes + turbo lint + the ratchets
#   bash scripts/ci-gate.sh verify   the same, with turbo typecheck, the scripts/
#                                    typecheck and test
#
# The plugin smokes and the root gates, and their order, live in
# scripts/ci/gates.ts; `bun run check:changed` reads the same list to pick the
# ones a change can affect. The smokes are ordered so provider-kit and
# plugin-kit are built ONCE. The first smoke deletes packages/plugin-kit/dist
# and proves the API tests do not rebuild it; `plugins:test-clean` then deletes
# it again and runs `plugins:check`, whose `plugins:prepare` is the single build
# of the run. The smokes after that need the dist, so they call their scripts
# directly instead of the package.json entries, which each prepend another
# `plugins:prepare` so they also work standalone.
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

# Each manifest line is one command of plain words. The list is read from fd 3
# so no step can consume the rest of it from stdin (and without mapfile, which
# the Bash 3.2 that macOS ships lacks).
run_manifest() {
	local commands line argv
	commands=$(bun scripts/ci/gates.ts "$1")
	[[ -n "$commands" ]] || { echo "ci-gate: empty $1 list" >&2; exit 1; }
	while IFS= read -r line <&3; do
		read -ra argv <<<"$line"
		step "${argv[@]}"
	done 3<<<"$commands"
}

run_manifest smokes

step bunx turbo "${turbo_tasks[@]}" "${turbo_concurrency_args[@]}" --filter='!@owlat/desktop'
# scripts/ is not a workspace, so turbo typecheck never reaches it; the root
# scripts and their tests get their own tsc run (ci:typecheck does the same).
if [[ "$1" == verify ]]; then
	step bun run typecheck:scripts
fi

# The root gates, ending with lint:plugin-imports without its plugins:prepare
# prefix (see above). script-tests is the single vitest boot for
# scripts/__tests__, the unit tests for the gate scripts themselves. It used to
# be a `vitest run <file>` prefix inside each lint:* entry, which booted vitest
# once per gate and left the test files without a matching lint:* entry running
# only in security.yml.
run_manifest gates
