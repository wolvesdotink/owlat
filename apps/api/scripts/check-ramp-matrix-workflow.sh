#!/usr/bin/env bash
#
# check-ramp-matrix-workflow.sh
#
# The ramp gate suite is accepted on a CI matrix that runs BOTH legs
# (reference_arm and standalone) over convex/delivery/ramp AND
# convex/delivery/signals, passes the mode through the environment variable the
# suite reads, sets the sentinel that makes a missing mode fatal in that leg
# only, and feeds the required status check. A matrix renamed, dropped in a
# merge or left dangling is indistinguishable from one that never existed, so
# the files themselves are read: the workflow for the job, the matrix and the
# required check; scripts/test-ramp.sh (what the job and `bun run test:ramp`
# run) for the env pair and the globs.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

workflow=../../.github/workflows/test.yml
runner=scripts/test-ramp.sh
mode_module=convex/delivery/ramp/__tests__/gateMatrixMode.ts

for f in "$workflow" "$runner"; do
	if [ ! -f "$f" ]; then
		echo "check-ramp-matrix-workflow: $f not found" >&2
		exit 1
	fi
done

# The env var names come off the module the suite reads them from, so a rename
# there fails here rather than silently defaulting the standalone leg.
mode_env=$(sed -n "s/^export const RAMP_GATE_MATRIX_ENV = '\([A-Z_]*\)';$/\1/p" "$mode_module")
sentinel_env=$(sed -n "s/^export const RAMP_GATE_MATRIX_SENTINEL_ENV = '\([A-Z_]*\)';$/\1/p" "$mode_module")
if [ -z "$mode_env" ] || [ -z "$sentinel_env" ]; then
	echo "check-ramp-matrix-workflow: could not read the env var names off $mode_module" >&2
	exit 1
fi

status=0
require() {
	if ! grep -qF -- "$2" "$1"; then
		echo "FAIL: $1 lacks: $2 ($3)" >&2
		status=1
	fi
}

require "$workflow" 'ramp-gate-matrix:' 'the matrix job'
require "$workflow" 'mode: [reference_arm, standalone]' 'both legs'
require "$workflow" 'run: bun run test:ramp ${{ matrix.mode }}' 'the leg runs the shared script with its mode'
require package.json '"test:ramp": "bash scripts/test-ramp.sh"' 'bun run test:ramp is the script the job runs'

# The sentinel + mode pair is set together, once, on the vitest invocation.
if ! grep -qE "^[[:space:]]*$sentinel_env=1 $mode_env=\"\\\$mode\"" "$runner"; then
	echo "FAIL: $runner does not set $sentinel_env=1 and $mode_env together on the leg it runs" >&2
	status=1
fi
require "$runner" 'bunx vitest run convex/delivery/ramp convex/delivery/signals' 'the signal registry runs in both legs'

# The sentinel belongs to the matrix leg only; a workflow-level env would make
# every other job's missing mode fatal.
sentinel_count=$(grep -cE "^[[:space:]]+$sentinel_env:" "$workflow" || true)
if [ "$sentinel_count" -ne 0 ]; then
	echo "FAIL: $sentinel_env is set $sentinel_count times in $workflow; the leg's script sets it, no job may" >&2
	status=1
fi

# Here-string, not a pipe — see check-ramp-decision-path.sh for why `grep -q`
# downstream of a still-writing producer fails under pipefail.
test_summary=$(sed -n '/^  test-summary:/,$p' "$workflow")
if ! grep -q 'ramp-gate-matrix' <<<"$test_summary"; then
	echo "FAIL: test-summary does not need ramp-gate-matrix — the matrix is not a required check" >&2
	status=1
fi

if [ "$status" -eq 0 ]; then
	echo "check-ramp-matrix-workflow: OK"
fi
exit "$status"
