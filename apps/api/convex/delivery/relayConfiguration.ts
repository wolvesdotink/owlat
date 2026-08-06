/**
 * THE RELAY LIST — the ONE reading of "which transports are the second arm".
 *
 * Seven readers ask something of the configured non-MTA transports: the
 * alignment pre-flight builds the reference arm from it, the ramp's enrolment
 * fork and its reset door ask whether a second sender exists AT ALL, the
 * dashboard, the independence read and the return-path read ask WHICH one it
 * is, and the controls view (`rampControlQueries.getRampControls`) asks BOTH —
 * the reader {@link relayConfiguration} was shaped around. All of them
 * answer from this one scan and this one rule — two implementations of "which
 * transport is the second arm" would drift into telling the operator two
 * different stories about one configuration.
 *
 * A SIBLING of `alignmentPreflight.ts` rather than a section inside it. The
 * pre-flight is the alignment sweep's state half; every reader above except the
 * sweep imports nothing else from that file, so the list belongs beside it and
 * not in it.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import { getOptional } from '../lib/env';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { bindsPhaseLadder } from './ramp/degradation';
import type { RampDegradation } from './ramp/degradation';

/** Upper bound on the (per-messageType) route rows we inspect for a relay. */
const PROVIDER_ROUTE_SCAN_LIMIT = 16;

/** Read-only ctx: the ramp controller's hourly tick is a mutation and reads this. */
type RelayReadCtx = QueryCtx | MutationCtx;

/**
 * Every configured non-MTA transport kind, from the SHIPPED surfaces: each
 * enabled `providerRoutes` entry plus the single-transport `EMAIL_PROVIDER` env.
 * The shipped transport set is wider than SES (`mta`/`ses`/`resend`/`smtp` plus
 * `plugin.*`), so answering this from the SES identity table alone would report
 * "single arm" for a Resend/SMTP/plugin relay and let two genuinely unaligned
 * arms ramp.
 */
export async function configuredRelayKinds(ctx: RelayReadCtx): Promise<string[]> {
	// One row per messageType — tiny by construction, and bounded anyway.
	const routes = await ctx.db.query('providerRoutes').take(PROVIDER_ROUTE_SCAN_LIMIT);
	const kinds = new Set<string>();
	for (const route of routes) {
		for (const provider of route.providers) {
			if (provider.isEnabled && provider.providerType !== OWN_ARM_TRANSPORT_KIND)
				kinds.add(provider.providerType);
		}
	}
	const envProvider = getOptional('EMAIL_PROVIDER')?.trim();
	if (envProvider !== undefined && envProvider !== '' && envProvider !== OWN_ARM_TRANSPORT_KIND) {
		kinds.add(envProvider);
	}
	return [...kinds].sort();
}

/**
 * The REFERENCE transport id — the second arm — or null when there is not
 * exactly one.
 *
 * Deliberately not "the active transport": on a standalone deployment the
 * active transport is the own MTA, and answering the reference question with it
 * would describe our own infrastructure under copy that says "this provider".
 * Zero relays is the standalone configuration (null, and the caller says so
 * plainly); more than one means there is no single second arm to describe, which
 * is exactly the answer `alignmentPreflight.referenceFor` gives that
 * configuration.
 *
 * A kind maps onto its DEFAULT transport id, which is the kind itself
 * (`defaultSendTransportId`); an id this deployment cannot resolve is resolved
 * by every caller to a degraded posture rather than an error (D2).
 */
export async function referenceRelayTransportId(ctx: RelayReadCtx): Promise<string | null> {
	return referenceTransportIdOf(await configuredRelayKinds(ctx));
}

/** The "exactly one kind" rule itself, over a list already read. */
function referenceTransportIdOf(kinds: readonly string[]): string | null {
	return kinds.length === 1 ? (kinds[0] ?? null) : null;
}

/** Both readings of the relay list — see {@link relayConfiguration}. */
export interface RelayConfiguration {
	/** The single second arm, or null when there is not exactly one. */
	readonly referenceTransportId: string | null;
	/** Is there a second sender AT ALL — the question the ramp's doors ask. */
	readonly isRelayConfigured: boolean;
}

/**
 * BOTH READINGS OF THE RELAY LIST, FROM ONE SCAN.
 *
 * "Which single arm is the reference one" and "is there a second sender at all"
 * are different questions — they disagree on a two-relay deployment, where the
 * reset door cuts and there is still no arm to name — so a screen that shows the
 * ramp's position needs both, and takes both off one reading.
 *
 * The "exactly one" rule stays in {@link referenceTransportIdOf} rather than
 * being restated at the call site — a second copy of it is how the two answers
 * would start disagreeing about one list.
 */
export async function relayConfiguration(ctx: RelayReadCtx): Promise<RelayConfiguration> {
	const kinds = await configuredRelayKinds(ctx);
	return {
		referenceTransportId: referenceTransportIdOf(kinds),
		isRelayConfigured: kinds.length > 0,
	};
}

/**
 * IS THERE A SECOND SENDER TO HOLD A SHARE BACK FOR — the question both phase
 * doors ask before they say anything about what a rung does.
 *
 * A UNION, and each half is there for a case the other gets wrong. The
 * CONFIGURATION half answers for the cell the doors exist for: a graduated cell
 * sits at full share and pinned, so it sends nothing through the relay by
 * construction and the tick measures no reference arm — asking the measurement
 * alone would deny a relay the operator is looking at. The MEASURED half is not
 * a leftover: a relay disconnected in the last day can still be carrying this
 * cell inside the evaluation window, and the tick binds the ladder on that
 * reading, so a door that ignored it would speak over a bound the controller is
 * already applying.
 *
 * ONE HELPER because the answer decides what an operator is TOLD, permanently —
 * `resetCellPhase` words its sentence on it and `rampPhasePromotion` words its
 * own on it, and two copies of this union are two chances for one timeline to
 * carry two accounts of the same deployment.
 *
 * The degradation is a PARAMETER: both callers have already loaded it for their
 * own rule, and loading it twice would let the two halves of one decision read
 * two different ticks.
 */
export async function hasSecondSender(
	ctx: RelayReadCtx,
	degradation: RampDegradation
): Promise<boolean> {
	return (await configuredRelayKinds(ctx)).length > 0 || bindsPhaseLadder(degradation);
}
