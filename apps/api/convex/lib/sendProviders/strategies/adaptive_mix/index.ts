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
 * OUTSIDE apps/api IT IS THE CATALOG'S `tier: 'own'` — `OWN_SEND_PROVIDER_KIND`
 * and `isOwnSendProviderKind` in `@owlat/shared` (the seams plan's P1.1), which
 * DERIVE the same fact from the entry declaring that tier. `apps/web`,
 * `apps/setup-cli` and `packages/shared` may not import backend code, so before
 * the catalog moved they had no declaration to read and restated `=== 'mta'` in
 * seven places; those are gone. The constant here stays written out because it
 * carries a LITERAL TYPE that three compile-time guards key off (a value derived
 * with `find` cannot), and `lib/sendProviders/__tests__/registry.test.ts` pins
 * the two equal so the pair cannot drift.
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
 * WHAT STILL SPELLS A KIND is DATA IN THREE PLACES, none of them this docblock,
 * and none of them derived from another — prose here would go stale the first
 * time a family cleared, with nothing failing:
 *
 *   * DECLARATIONS in `apps/api/convex` (`const X = 'ses'`) —
 *     `SURVIVING_KIND_LITERALS` in
 *     `lib/sendProviders/__tests__/kindLiteralCustody.test.ts`, each entry with
 *     its family and its owner, asserted in both directions. This declaration is
 *     in it, as the one `definitional` entry; so, in spirit, is
 *     `domains/providers/mta/index.ts`'s `kind`, inside an adapter folder the
 *     rule does not reach. That map holds declarations ONLY.
 *   * COMPARISONS that are debt — `scripts/provider-identity-allowlist.txt`,
 *     read by `bun run lint:providers` over `apps/`, `packages/` and
 *     `examples/`. Each entry sits under a family header naming the piece that
 *     deletes it; the count is what acceptance criterion A1 measures, and the
 *     gate fails on an entry that no longer excuses anything.
 *   * COMPARISONS that are NOT debt — `scripts/provider-identity-collisions.txt`,
 *     for a spelling that belongs to another alphabet: the MTA routing API's
 *     `'mta' | 'relay' | 'defer'` answer (`delivery/lastMileRouting.ts`), a
 *     docker compose profile, the contact-import source registry. Permanent, and
 *     `path:literal`-qualified so the licence covers that spelling and nothing
 *     else. Rewriting one of these would change a protocol, not remove a
 *     coupling, so it must NOT go in the allowlist — that is what lets the
 *     allowlist reach zero.
 *
 * Read those three, not this list. For orientation only, the surviving families
 * as of P0.5: the RETURN-PATH pair (`domains/lifecycle.ts`,
 * `delivery/checklistDomainValidators.ts`), waiting on a capability that has no
 * home on the sending-domain adapter interface yet; FROZEN-SIBLING READS
 * (`providerRoutes.listDeliverabilityRelayDomains`,
 * `delivery/checklistValidatorTypes.ts`), retired by the generic
 * `sendingDomainRelayIdentities` read in P1.2; ADAPTER-ADJACENT actions living
 * beside an adapter rather than inside it (`domains/mandrillRelay*.ts`,
 * `webhooks/mandrillRejectSuppression.ts`); and the provider-shaped UI branches
 * in `apps/web`, which P1.2 and its follow-up delete.
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
