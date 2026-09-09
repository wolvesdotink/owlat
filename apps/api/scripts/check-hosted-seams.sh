#!/usr/bin/env bash
#
# check-hosted-seams.sh
#
# Every hosted contribution seam (convex/plugins/*Authorization.ts) runs the
# SAME authorization sequence through hostedContributionAuthorization.ts. Five
# seams used to re-implement it, and the wire contracts had drifted (three took
# `success: boolean` where five took an `outcome` union). A seam that does not
# delegate, or that reaches for the building blocks the shared helper owns,
# fails here. Source-level on purpose: "there is exactly one implementation" is
# not a property per-seam behavioural tests can establish.
#
set -uo pipefail
cd "$(dirname "$0")/.." # apps/api

shared=hostedContributionAuthorization
seams=$(ls convex/plugins/*Authorization.ts | grep -v "/$shared.ts$" | sort)
count=$(printf '%s\n' "$seams" | grep -c . || true)

status=0
if [ "$count" -lt 8 ]; then
	echo "FAIL: only $count seam modules found under convex/plugins — the glob no longer matches" >&2
	status=1
fi
for landmark in convex/plugins/sendTransportAuthorization.ts convex/plugins/agentStepAuthorization.ts; do
	if ! printf '%s\n' "$seams" | grep -qx "$landmark"; then
		echo "FAIL: $landmark is not among the seams" >&2
		status=1
	fi
done

for seam in $seams; do
	for needed in "from './$shared'" 'HostedContributionAuthorizationSpec' 'authorizeHostedContribution('; do
		if ! grep -qF -- "$needed" "$seam"; then
			echo "FAIL: $seam must build on $shared (missing $needed)" >&2
			status=1
		fi
	done
	for forbidden in authorizeSystemBundledPlugin recordHostedPluginAudit SYSTEM_PLUGIN_ACTOR_ID getSingletonOrganizationId "reasonCode: 'access_denied'"; do
		if grep -qF -- "$forbidden" "$seam"; then
			echo "FAIL: $seam re-implements the sequence ($forbidden) — delegate to $shared" >&2
			status=1
		fi
	done
	if grep -q 'recordOutcome' "$seam"; then
		if grep -qF 'success: v.boolean()' "$seam"; then
			echo "FAIL: $seam still takes a boolean outcome; use completedOrFailedValidator" >&2
			status=1
		fi
		if ! grep -qF 'outcome: completedOrFailedValidator' "$seam"; then
			echo "FAIL: $seam records outcomes off the one wire contract (outcome: completedOrFailedValidator)" >&2
			status=1
		fi
	fi
done

if [ "$status" -eq 0 ]; then
	echo "check-hosted-seams: OK ($count seams)"
fi
exit "$status"
