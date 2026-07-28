/**
 * The per-message MIX concern of route resolution: which tenant and which cell
 * a message belongs to, and which arm of that cell it takes.
 *
 * Split out of `route.ts` so the authoritative resolver keeps owning the route
 * config, the health map and the fallback sequence, while everything the
 * controller-owned `adaptive_mix` strategy needs to answer "which arm is THIS
 * recipient in" lives in one cohesive place next to it. `route.ts` is the only
 * consumer; nothing here reads `providerHealth`, so the enqueue-side cell seam
 * (`cellRoute.ts`) is unaffected either way.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { extractDomainOrNull } from '@owlat/shared';
import { resolveDestinationProvider } from './destinationProvider';
import {
	loadRouteStateCell,
	mixCellStateFor,
	type RouteStateCellRows,
} from '../deliverabilityRouteState';
import type { MixContext } from './strategies';
import { readAssignmentForSend } from '../../delivery/sendAssignments';
import { getSingletonOrganizationId } from '../sessionOrganization';
import type { MessageType } from './routeInputs';

/**
 * The identity fields the mix concern keys off. `SendRouteAddressContext`
 * (`route.ts`) extends this, so the resolver can hand its context straight
 * through without this module depending on the resolver's shape.
 */
export interface MixAddressIdentity {
	to?: string;
	now?: number;
	/**
	 * The durable Send id, when the caller has one. THIS is what makes the
	 * dispatched transport and the recorded arm the same answer under
	 * `adaptive_mix`: the arm was decided and recorded at enqueue, and this
	 * resolution replays that record rather than re-deriving a decision whose
	 * stratification input (the recipient's percentile within the enqueue
	 * batch's cohort) no single message can reconstruct. Without it a split
	 * cell would dispatch every recipient on one transport while the assignment
	 * rows described an `s`-proportioned split, and every rate derived from
	 * those denominators would describe an experiment that never ran.
	 */
	sendId?: string;
}

/**
 * Per-message inputs the deliverability layer keys off. Extends the mix
 * identity above so the resolver can hand ONE context to both consumers, and
 * lives here rather than in `route.ts` so `routeDeliverabilityInput.ts` can
 * name it without an import edge back to the resolver. `route.ts` re-exports
 * it for existing importers.
 */
export interface SendRouteAddressContext extends MixAddressIdentity {
	from?: string;
	baseOnly?: boolean;
	forceRelayReason?: 'breaker_open' | 'warmup_overflow';
}

/**
 * Inputs a caller has already paid for and can hand back, so a second
 * resolution of the SAME message does not re-read them. Presence of the object
 * is the signal — a present object with `mix: undefined` means "there is no mix
 * context", not "compute one".
 */
export interface PrecomputedRouteInputs {
	readonly mix: MixContext | undefined;
}

/**
 * The tenant + cell identity BOTH per-message consumers key off, resolved
 * ONCE per resolution.
 *
 * The mix context and the deliverability input used to derive this pair
 * independently — the same singleton-organization lookup, the same domain
 * parse, the same classifier read and the same route-state cell read, with the
 * same arguments. Two copies of "which tenant is this and which cell is the
 * recipient in" have to agree forever, and under `adaptive_mix` they also
 * doubled the indexed reads on the authoritative per-message path.
 *
 * `cell` is left PENDING deliberately: both consumers await it inside their own
 * parallel read set, so the cell read still overlaps the stream-less route
 * state and the warming state exactly as it did before this pair was hoisted.
 * It resolves to null when there is no recipient address, or none that parses:
 * the tenant is still known, which is all the recorded-arm replay needs.
 */
export interface ResolvedAddressCell {
	readonly organizationId: string;
	readonly now: number;
	readonly cell: Promise<RouteStateCellRows | null>;
}

export async function resolveAddressCell(
	ctx: QueryCtx | MutationCtx,
	messageType: MessageType,
	addressContext: MixAddressIdentity | undefined
): Promise<ResolvedAddressCell | null> {
	const now = addressContext?.now ?? Date.now();
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		return null;
	}
	const to = addressContext?.to;
	const toDomain = to ? extractDomainOrNull(to) : null;
	if (toDomain === null) return { organizationId, now, cell: Promise.resolve(null) };
	const destinationProvider = await resolveDestinationProvider(ctx, organizationId, toDomain, now);
	return {
		organizationId,
		now,
		cell: loadRouteStateCell(ctx, organizationId, {
			stream: messageType,
			destinationProvider,
		}),
	};
}

/**
 * The mix context for ONE message, in priority order:
 *
 *   1. THE RECORDED ARM. When the caller carries a Send id and an assignment
 *      row exists, that row is the answer. It is the row every rate in the
 *      measurement plane is joined on, and one of its inputs — the recipient's
 *      engagement percentile within the enqueue batch's cohort — is a property
 *      of that batch, so it cannot be reconstructed from a single message.
 *      Replaying the record is therefore the ONLY way the dispatched transport
 *      and the recorded arm can be the same answer.
 *   2. A DERIVED DECISION. No row (a send that predates the experiment, or a
 *      recording that degraded — it is allowed to, since recording must never
 *      fail a send) and no batch to rank against: decide from the cell's share
 *      with the most stable identity in hand. Nothing is joined against this
 *      one, so nothing can disagree with it, and it still realises the cell's
 *      configured share.
 *
 * The identity of last resort is the recipient address, which is what the
 * ADVISORY pre-resolutions hold (campaign sending resolves one route per page
 * from the first recipient, before any Send row exists). They get a
 * share-proportioned answer rather than a null one — a null there would stall a
 * campaign walk — and the authoritative dispatch resolution, which does carry
 * the Send id, still replays the record.
 *
 * Costs nothing on any shipped route: it short-circuits unless the org has
 * explicitly selected the controller-owned `adaptive_mix` strategy.
 */
export async function mixContextFor(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null,
	addressContext: MixAddressIdentity | undefined,
	resolved: ResolvedAddressCell | null
): Promise<MixContext | undefined> {
	if (routeConfig?.strategy !== 'adaptive_mix') return undefined;
	if (resolved === null) return undefined;
	const sendId = addressContext?.sendId;
	// Both reads at once, and the cell is awaited on EVERY path through this
	// function — the resolver hands over a pending read, so a branch that
	// dropped it would leave that read unobserved.
	const [cell, recorded] = await Promise.all([
		resolved.cell,
		sendId === undefined
			? undefined
			: readAssignmentForSend(ctx.db, resolved.organizationId, sendId),
	]);
	if (recorded) return { kind: 'assigned', arm: recorded.arm };
	if (cell === null) return undefined;
	// Absence is expressed as ABSENCE, not as an empty string standing in for
	// one: a durable send id when there is one, else the recipient address, else
	// no identity at all — the decision then takes its documented unidentified
	// branch instead of asking a downstream module to re-interpret a sentinel.
	const fallbackKey = sendId ?? addressContext?.to;
	return {
		kind: 'decide',
		input: {
			cell: mixCellStateFor(cell),
			recipient: fallbackKey !== undefined ? { fallbackKey } : {},
		},
	};
}
