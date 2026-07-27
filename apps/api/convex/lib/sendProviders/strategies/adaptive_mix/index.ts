/**
 * `adaptive_mix` send route strategy.
 *
 * Per ADR-0020, a FOURTH PEER of the shipped three — not a rewrite of the
 * strategy layer. What it replaces is the per-page coin flip: `workload_split`
 * draws with `Math.random()` on every call, so the same recipient can land on a
 * different transport at enqueue than at dispatch, and a recorded arm is a
 * guess. `adaptive_mix` decides per RECIPIENT, deterministically, from the
 * cell's controlled share (plan D7).
 *
 * The share it splits against is the D1 expression
 * (`ownShare ?? (isFallbackActive ? 0 : 1)`), resolved by the caller. That
 * makes the degenerate cases the shipped behaviour exactly: `s = 0` sends the
 * whole cell to the reference arm (what a fallback-active cell does today),
 * `s = 1` sends it all to the own MTA (what a cell with no state does today).
 *
 * The strategy IS deterministic (`isDeterministic: true`) — that is the point
 * of the piece — but only when it is given a recipient. Without a mix context
 * it has no recipient to hash and degrades to the first enabled provider, the
 * same answer `single` gives.
 */

import type { ProviderEntry, SendRouteStrategyModule } from '../types';
import { decideMixAssignment } from './mix';

export {
	calibrationSliceFor,
	decideMixAssignment,
	DEFAULT_MIX_VERSION,
	MIX_ARMS,
	CALIBRATION_SLICE_AT_OR_ABOVE_HALF,
	CALIBRATION_SLICE_BELOW_HALF,
	CALIBRATION_WIDE_SLICE_MAX_SHARE,
} from './mix';
export type {
	MixArm,
	MixAssignment,
	MixAssignmentBasis,
	MixAssignmentInput,
	MixCellState,
	MixRecipientIdentity,
} from './mix';
export { bucketFor, hash32, MIX_BUCKET_SPACE } from './hash';

/**
 * The transport kind that IS the own arm. Every other catalog transport (SES,
 * Resend, an SMTP relay, a plugin transport) is a reference arm.
 */
export const OWN_ARM_TRANSPORT_KIND = 'mta';

function referenceEntryOf(entries: readonly ProviderEntry[]): ProviderEntry | undefined {
	return entries.find((entry) => entry.providerType !== OWN_ARM_TRANSPORT_KIND);
}

export const adaptiveMixStrategy: SendRouteStrategyModule<'adaptive_mix'> = {
	kind: 'adaptive_mix',
	isDeterministic: true,
	select(entries, ipPool, _healthStatuses, mix) {
		const first = entries[0];
		if (!first) return null;
		// No recipient in hand — nothing to split. The enqueue-time cell seam and
		// the dispatch-time resolver both supply one; a caller that does not
		// (a health probe, a preflight check) gets `single`'s answer.
		if (!mix) return { providerType: first.providerType, ipPool, source: 'org_config' };

		const decision = decideMixAssignment(mix);
		const own = entries.find((entry) => entry.providerType === OWN_ARM_TRANSPORT_KIND);
		const reference = referenceEntryOf(entries);
		// THE ADDITIVE-ONLY THIRD-PARTY RULE (D2): a cell whose share says
		// "reference" on a deployment with no reference transport configured
		// still sends — on the own MTA. Absence of an external account lowers
		// measurement confidence; it never blocks a send.
		const chosen = (decision.arm === 'own' ? own : reference) ?? own ?? reference ?? first;
		return { providerType: chosen.providerType, ipPool, source: 'org_config' };
	},
};
