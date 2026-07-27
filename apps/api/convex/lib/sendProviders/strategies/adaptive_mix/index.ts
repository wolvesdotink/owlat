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
 * of the piece — but only when it is given a mix context. WITHOUT ONE IT
 * RETURNS NULL, and the caller falls back explicitly (the env fallback). It
 * deliberately does NOT degrade to "the first enabled provider": that answer is
 * `single`'s, it is silent, and it would put 100% of a split cell on one
 * transport while the assignment rows recorded an `s`-proportioned split — every
 * rate the controller then derives would be computed over denominators
 * describing an experiment that never ran. A missing answer the caller has to
 * handle is better than a confident wrong one.
 */

import type { ProviderEntry, SendRouteStrategyModule } from '../types';
import { decideMixAssignment } from './mix';
import type { MixArm } from './mix';

export {
	armBucketFor,
	calibrationBucketFor,
	calibrationSliceFor,
	decideMixAssignment,
	rankTieBreakUnit,
	DEFAULT_MIX_VERSION,
	CALIBRATION_SLICE_AT_OR_ABOVE_HALF,
	CALIBRATION_SLICE_BELOW_HALF,
} from './mix';
export type {
	MixArm,
	MixAssignment,
	MixAssignmentBasis,
	MixAssignmentInput,
	MixCellState,
	MixContext,
	MixHashConsumer,
	MixRecipientIdentity,
} from './mix';
export { bucketFor, hash32, MIX_BUCKET_SPACE } from './hash';

/**
 * The transport kind that IS the own arm. Every other catalog transport (SES,
 * Resend, an SMTP relay, a plugin transport) is a reference arm.
 */
export const OWN_ARM_TRANSPORT_KIND = 'mta';

/** Both arms of a route, found in one pass so neither lookup can drift. */
function armEntries(entries: readonly ProviderEntry[]): {
	own: ProviderEntry | undefined;
	reference: ProviderEntry | undefined;
} {
	return {
		own: entries.find((entry) => entry.providerType === OWN_ARM_TRANSPORT_KIND),
		reference: entries.find((entry) => entry.providerType !== OWN_ARM_TRANSPORT_KIND),
	};
}

export const adaptiveMixStrategy: SendRouteStrategyModule<'adaptive_mix'> = {
	kind: 'adaptive_mix',
	isDeterministic: true,
	select(entries, ipPool, _healthStatuses, mix) {
		const first = entries[0];
		if (!first) return null;
		// No mix context — no recipient to split on, and no recorded decision to
		// replay. Answering anyway would be a guess; the caller falls back.
		if (!mix) return null;

		const decision = mix.kind === 'decide' ? decideMixAssignment(mix.input) : null;
		const arm: MixArm = decision?.arm ?? (mix.kind === 'assigned' ? mix.arm : 'reference');
		const { own, reference } = armEntries(entries);
		// THE ADDITIVE-ONLY THIRD-PARTY RULE (D2): a cell whose share says
		// "reference" on a deployment with no reference transport configured
		// still sends — on the own MTA. Absence of an external account lowers
		// measurement confidence; it never blocks a send.
		const chosen = (arm === 'own' ? own : reference) ?? own ?? reference ?? first;
		return {
			providerType: chosen.providerType,
			ipPool,
			source: 'org_config',
			// The decision travels WITH the route, so the caller that records the
			// experiment reads it instead of evaluating the same pure function a
			// second time — one decision, in one place, with nothing to keep in
			// agreement.
			...(decision !== null ? { mix: decision } : {}),
		};
	},
};
