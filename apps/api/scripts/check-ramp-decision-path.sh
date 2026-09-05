#!/usr/bin/env bash
#
# check-ramp-decision-path.sh
#
# The ramp substitutions are DATA (plan D3): the degradation matrix has exactly
# one fold, convex/delivery/ramp/degradation.ts, and the modules that DECIDE
# reach its constants only through that fold. Three source-level rules:
#   1. no line of the decision path names an integration (an account, not a
#      measurement) — reads included, not only conditionals;
#   2. nothing on the decision path reads the matrix directly;
#   3. rampControllerInputs.ts takes every constant through the fold's functions.
# The data half (every table entry governs a real cell, every substitution
# source is reachable) stays behavioural in
# convex/delivery/ramp/__tests__/noScatteredConditionals.test.ts.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

decision_path=(
	convex/delivery/ramp/controller.ts
	convex/delivery/ramp/controllerBounds.ts
	convex/delivery/ramp/controllerConfig.ts
	convex/delivery/ramp/gates.ts
	convex/delivery/ramp/gateEvaluation.ts
	convex/delivery/signals/rampGateSources.ts
	convex/delivery/rampControllerInputs.ts
	convex/delivery/rampControllerCron.ts
)
matrix=convex/delivery/ramp/degradationMatrix.ts
inputs=convex/delivery/rampControllerInputs.ts

# Deliberately not `reference` or `seed` alone: the reference ARM and the seed
# PLACEMENT GATE are measurements the decision path is supposed to name.
vocabulary='\b(snds|postmaster|reference_transport|seed_mailboxes|commercial_placement|feedback_loop|hasRelay|hasEsp|cfbl)\b'

strip_comments() {
	awk '
		{
			line = $0; out = ""
			while (length(line) > 0) {
				if (inblock) {
					i = index(line, "*/")
					if (i == 0) { line = ""; break }
					line = substr(line, i + 2); inblock = 0
				} else {
					b = index(line, "/*"); c = index(line, "//")
					# A `//` before any `/*`, and not the `//` of a URL scheme, ends the
					# code on this line — so `// see /api/x/*` cannot open a block.
					if (c > 0 && (b == 0 || c < b) && (c == 1 || substr(line, c - 1, 1) != ":")) {
						out = out substr(line, 1, c - 1); line = ""
					} else if (b == 0) {
						out = out line; line = ""
					} else {
						out = out substr(line, 1, b - 1); line = substr(line, b + 2); inblock = 1
					}
				}
			}
			print out
		}' "$1"
}

status=0
for file in "${decision_path[@]}" "$matrix"; do
	if [ ! -f "$file" ]; then
		echo "FAIL: $file missing — the decision path moved; update this script" >&2
		exit 1
	fi
done

# The vocabulary must fire on the table that legitimately names integrations,
# or every rule below passes vacuously.
if ! strip_comments "$matrix" | grep -Eiq "$vocabulary"; then
	echo "FAIL: the integration vocabulary matches nothing in $matrix — the check is vacuous" >&2
	exit 1
fi

for file in "${decision_path[@]}"; do
	hits=$(strip_comments "$file" | grep -Ein "$vocabulary" || true)
	if [ -n "$hits" ]; then
		echo "FAIL: $file names an integration on the decision path (read measurements, never accounts):" >&2
		printf '%s\n' "$hits" >&2
		status=1
	fi
	if strip_comments "$file" | grep -Eq 'RAMP_DEGRADATION_MATRIX|RAMP_DEGRADATION_BY_INTEGRATION'; then
		echo "FAIL: $file reads the degradation matrix directly — only degradation.ts folds it" >&2
		status=1
	fi
done

for fold in resolveRampDegradation degradedStreamConfig degradedCeilingCap usesTrailingBaseline usesUnsubscribeProxy; do
	if ! strip_comments "$inputs" | grep -q "$fold("; then
		echo "FAIL: $inputs no longer calls $fold( — the decision path must take its constants through the fold" >&2
		status=1
	fi
done

if [ "$status" -eq 0 ]; then
	echo "check-ramp-decision-path: OK"
fi
exit "$status"
