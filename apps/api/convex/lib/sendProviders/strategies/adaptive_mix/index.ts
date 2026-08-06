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
	MixRecipientIdentity,
} from './mix';
export { bucketFor, hash32, MIX_BUCKET_SPACE } from './hash';

/**
 * The transport kind that IS the own arm. Every other catalog transport (SES,
 * Resend, an SMTP relay, a plugin transport) is a reference arm.
 *
 * THE ONE IDENTITY THE SEAMS PLAN SANCTIONS (its D3): own vs. not-own is a
 * definition, not a branch on a provider's name, and this declaration plus its
 * domain-provider twin (`OWN_SENDING_DOMAIN_PROVIDER_KIND`, pinned equal to it
 * at build time) are where that definition lives. The rule is that every other
 * "is this our own MTA?" test READS one of the two rather than restating the
 * literal.
 *
 * THE OWN-ARM SWEEP IS DONE (the seams plan's P0.4). Every site outside the
 * adapter folders that asked "is this our own MTA?" now reads this constant or
 * its domain-provider twin — the send lifecycle, the webhook dispatcher and the
 * complaint handler, delivery status, the seed-probe arm attribution in the
 * worker, last-mile routing, the checklist and its loopback gates, delivery
 * health, the relay-kind definition in `delivery/relayConfiguration.ts`, the
 * hybrid detection in `route.ts`/`routing.ts` (through
 * `fallbackEligibility.routeCarriesOwnArm`), the stream-subdomain wizard, the dev
 * force-verify shortcut and SES's relay provisioning action. So does the
 * measurement plane: `delivery/worker.ts` files a seed probe's arm through
 * `armForTransport`, the same function `sendAssignments` records with, rather
 * than through a second copy of the split.
 *
 * WHAT STILL SPELLS A KIND, and why none of it is an own-arm restatement the
 * allowlist could pass off as definitional. Written here rather than left for
 * the ratchet author (P0.5) to discover, because none of it is a substitution:
 * the first three need a capability that does not exist yet, and the fourth is
 * not a provider kind at all.
 *
 *   1. THE RETURN-PATH FAMILY. `domains/lifecycle.ts` decides which `mailFrom`
 *      bundle to publish and which reflection action to schedule by branching on
 *      `providerType`, and `delivery/checklistDomainValidators.ts`'s
 *      `domain.return_path` item restates the same branch to say what the
 *      ACTIVE return path is. That capability has no home on the sending-domain
 *      adapter interface yet (`domains/providers/index.ts` says so in full);
 *      giving it one moves both sites at once.
 *   2. SES-SHAPED READS of the frozen sibling table, largest being
 *      `providerRoutes.listDeliverabilityRelayDomains` — carried into P1.2 as an
 *      explicit added input, since the read and the component that renders it
 *      have to move together. `delivery/checklistValidatorTypes.ts`'s
 *      `RELAY_IDENTITY_PROOF_KIND` declares the same fact for the
 *      `deployment.relay` item and is retired by the same generic
 *      `sendingDomainRelayIdentities` read. `webhooks/complaintDispatch.ts`'s
 *      blocklist gate (which event sources carry a `deliveryDomain` tag) and
 *      `delivery/lastMileRouting.ts`'s relay-reconciliation gate are the same
 *      shape at a smaller scale.
 *   3. HISTORICAL AND ADAPTER-ADJACENT. `migrations/0018_*` rewrites rows that
 *      were written under the old spelling and must keep naming them;
 *      `domains/mandrillRelay.ts` and `domains/mandrillRelayMutations.ts` are
 *      one kind's provisioning actions living beside their adapter rather than
 *      inside it — the out-of-adapter pattern `docs/abstractions.md` records as
 *      unclaimed by any card, SES's `sesRelayMutations` included.
 *   4. NOT A PROVIDER KIND AT ALL, and must not be swept: the MTA's routing-API
 *      wire vocabulary (`decision.kind === 'mta'` in
 *      `delivery/lastMileRouting.ts` and `lib/sendProviders/mta/index.ts`) is
 *      `'mta' | 'relay' | 'defer'` on the response, a different alphabet that
 *      happens to share a spelling. A ratchet that rewrote it would change the
 *      protocol.
 *
 * So the ratchet (P0.5) seeds its allowlist with families 1–4 EXPLICITLY
 * enumerated and each carrying its owner, not with a blanket "definitional"
 * label — an allowlist that claims these are definitional stops meaning what
 * the plan says it means, and shrink-only then locks the claim in. The
 * definitional entries are exactly two: this declaration and
 * `domains/providers/mta/index.ts`'s `kind`, which its twin reads.
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

		const decided = mix.kind === 'decide' ? decideMixAssignment(mix.input) : null;
		const arm: MixArm = decided?.arm ?? (mix.kind === 'assigned' ? mix.arm : 'reference');
		const { own, reference } = armEntries(entries);
		// A calibration row is a member of a RANDOMIZED COMPARISON, so the slice
		// only exists while the route can express one. On a deployment with only
		// one arm configured — no reference transport (D2: a supported
		// configuration, not an incomplete setup), or no own MTA — every slice
		// member dispatches on the same transport, and marking those rows
		// calibration would hand the engagement-ratio gate a one-armed sample:
		// exactly the degenerate cell `calibrationSliceFor` zeroes the slice for.
		// The rows are still written — the sends happened and belong in the
		// denominators — they simply are not part of the experiment. THIS IS THE
		// ONLY PLACE that decides whether a row is calibration; the recorder
		// copies the flag through.
		const decision =
			decided !== null && decided.isCalibration && (own === undefined || reference === undefined)
				? { ...decided, isCalibration: false }
				: decided;
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
