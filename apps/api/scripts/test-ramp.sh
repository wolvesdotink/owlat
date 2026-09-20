#!/usr/bin/env bash
# The ramp-gate matrix (deliverability plan D2/D3): the ramp controller has two
# gate implementations behind one interface, the concurrent reference-arm one
# and the trailing-baseline one a deployment with zero third-party accounts
# runs. That deployment is a SUPPORTED CONFIGURATION, so the gate suite runs
# once per mode. The mode is load-bearing: `__tests__/gateFixtures.ts` refuses
# to build a reference arm in the standalone leg, and the suites that measure
# against one (`describeEquipped` / `itEquipped`) skip themselves there.
#
# OWLAT_RAMP_GATE_MATRIX is the sentinel that says "a matrix leg is running";
# with it set, a MISSING mode is an error rather than the equipped default
# (`__tests__/gateMatrixMode.ts`). Every other vitest run leaves both unset and
# gets the equipped leg.
#
#   bun run test:ramp                 both legs, one after the other
#   bun run test:ramp standalone      one leg (the CI matrix runs one per job)
#
# `convex/delivery/signals` holds the registry the evaluators fold (seams plan
# D9), so each leg has to cover it or it loses the half of the suite that says
# which gates it even runs.
set -euo pipefail
cd "$(dirname "$0")/.."

modes=("$@")
if [ ${#modes[@]} -eq 0 ]; then
	modes=(reference_arm standalone)
fi

for mode in "${modes[@]}"; do
	case "$mode" in
		reference_arm | standalone) ;;
		*)
			echo "usage: bash scripts/test-ramp.sh [reference_arm|standalone ...]; got '$mode'" >&2
			exit 2
			;;
	esac
	echo "== ramp gates ($mode)"
	OWLAT_RAMP_GATE_MATRIX=1 OWLAT_RAMP_GATE_MATRIX_MODE="$mode" \
		bunx vitest run convex/delivery/ramp convex/delivery/signals
done
