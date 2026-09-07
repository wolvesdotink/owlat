#!/usr/bin/env bash
#
# check-ramp-matrix-workflow.sh
#
# The ramp gate suite is accepted on a CI matrix that runs BOTH legs
# (reference_arm and standalone) over convex/delivery/ramp AND
# convex/delivery/signals, passes the mode through the environment variable the
# suite reads, sets the sentinel that makes a missing mode fatal in that job
# only, and feeds the required status check. A matrix renamed, dropped in a
# merge or left dangling is indistinguishable from one that never existed, so
# the workflow file itself is read.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

workflow=../../.github/workflows/test.yml
mode_module=convex/delivery/ramp/__tests__/gateMatrixMode.ts

if [ ! -f "$workflow" ]; then
	echo "check-ramp-matrix-workflow: $workflow not found" >&2
	exit 1
fi

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
	if ! grep -qF -- "$1" "$workflow"; then
		echo "FAIL: $workflow lacks: $1 ($2)" >&2
		status=1
	fi
}

require 'ramp-gate-matrix:' 'the matrix job'
require 'mode: [reference_arm, standalone]' 'both legs'
require "$mode_env: \${{ matrix.mode }}" 'the mode reaches the suite'
require "$sentinel_env: '1'" 'the sentinel that makes a missing mode fatal'
require 'bunx vitest run convex/delivery/ramp convex/delivery/signals' 'the signal registry runs in both legs'

sentinel_count=$(grep -cE "^[[:space:]]+$sentinel_env:" "$workflow" || true)
if [ "$sentinel_count" -ne 1 ]; then
	echo "FAIL: $sentinel_env is set $sentinel_count times in $workflow; it belongs to the matrix job only" >&2
	status=1
fi

if ! sed -n '/^  test-summary:/,$p' "$workflow" | grep -q 'ramp-gate-matrix'; then
	echo "FAIL: test-summary does not need ramp-gate-matrix — the matrix is not a required check" >&2
	status=1
fi

if [ "$status" -eq 0 ]; then
	echo "check-ramp-matrix-workflow: OK"
fi
exit "$status"
