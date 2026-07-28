/**
 * THE INDEPENDENCE SCREEN'S ONE READ (plan D2, D5, D14, P3-6).
 *
 * This is the screen people screenshot: the share of mail their own server
 * carries, how it has moved, when they stop paying, and what they have not spent
 * so far this month. Every number comes off the SAME daily series and the SAME
 * pure arithmetic the web screen imports (`@owlat/shared/deliverabilityIndependence`),
 * so the page and the server cannot disagree about a figure an operator is about
 * to put in front of their boss.
 *
 * D14 IS THE WHOLE SHAPE OF THIS FILE. With no reference transport there is
 * nothing to become independent OF, so the screen is not a degraded
 * "Independence" — it is "Warm-up autopilot", whose headline is TODAY'S CAPACITY
 * and what is holding it back. Both variants are answered here, from the same
 * read, and neither is an error state: `spendAvoidedMinorUnits` is simply `null`
 * when nobody has told us a relay price, and the projection is
 * `already_independent` rather than "unknown".
 *
 * D2: absence lowers confidence and does nothing else. No credential is read
 * here, nothing throws, and a fresh install with only an MTA renders every field
 * on this screen.
 */

import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	resolveOwnShare,
} from '@owlat/shared/deliverabilityRouting';
import {
	independenceShare,
	ownSendsSince,
	projectIndependenceDate,
	spendAvoidedMinorUnits,
	assessRelayRemoval,
	type IndependenceDayPoint,
	type IndependenceProjection,
	type RelayRemovalCellState,
	type RelayRemovalSafety,
} from '@owlat/shared/deliverabilityIndependence';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import { safeOutcomeCount } from '../analytics/transportOutcomeSummary';
import { referenceRelayTransportId } from './alignmentPreflight';
import { loadWarmingCapacity } from './warmingCapacity';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How much history the stacked chart shows. Bounded by the 90-day retention. */
const INDEPENDENCE_WINDOW_DAYS = 30;

function utcDayStart(at: number): number {
	return Math.floor(at / DAY_MS) * DAY_MS;
}

function utcMonthStart(at: number): number {
	const date = new Date(at);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * TODAY'S SENDING CAPACITY, and what bounds it — the standalone headline.
 *
 * `null` is an HONEST answer and never an error: no warming state, a stale sync,
 * or a graduated pool all mean there is no ceiling to quote. The screen says so
 * plainly rather than printing a zero that reads as "you may not send".
 */
export interface WarmupCapacityHeadline {
	readonly remainingToday: number | null;
	readonly projectedDays: readonly number[];
}

export interface IndependenceSummary {
	readonly generatedAt: number;
	/** The deployment's second arm, or `null` for a standalone install (D14). */
	readonly referenceTransportId: string | null;
	/** Own-arm share of everything sent in the window, or `null` for no traffic. */
	readonly ownShare: number | null;
	readonly series: readonly IndependenceDayPoint[];
	readonly projection: IndependenceProjection;
	/**
	 * Money not spent this month, in minor units, or `null` when nobody has told
	 * us a price. A product-invented rate would be quoted back at us.
	 */
	readonly spendAvoidedMinorUnits: number | null;
	readonly spendAvoidedCurrency: string | null;
	readonly monthToDateOwnSends: number;
	readonly relayRemoval: RelayRemovalSafety;
	readonly capacity: WarmupCapacityHeadline;
}

/**
 * Own- and reference-arm sends per UTC day, summed across every cell.
 *
 * `sent` is a RAW COUNTER, so it is read through `safeOutcomeCount` — the same
 * sanitiser the one summarizer applies — rather than re-summarized per day per
 * cell, which would run the full derivation 900 times to read one field. No rate
 * is computed here; every rate on the delivery screens still comes off the
 * summarizer (plan D5).
 */
async function readIndependenceSeries(
	ctx: QueryCtx,
	args: { organizationId: string; sinceDay: number; untilDay: number; hasReferenceArm: boolean }
): Promise<IndependenceDayPoint[]> {
	const own = new Map<number, number>();
	const reference = new Map<number, number>();
	for (const cell of allDeliverabilityCells()) {
		const cellKey = deliverabilityCellKey(cell);
		const window = { since: args.sinceDay, until: args.untilDay };
		const ownBuckets = await readCellArmBuckets(ctx.db, {
			organizationId: args.organizationId,
			cell: cellKey,
			arm: 'own',
			...window,
		});
		for (const bucket of ownBuckets) {
			if (!Number.isFinite(bucket.periodStart)) continue;
			own.set(
				bucket.periodStart,
				(own.get(bucket.periodStart) ?? 0) + safeOutcomeCount(bucket.sent)
			);
		}
		if (!args.hasReferenceArm) continue;
		const referenceBuckets = await readCellArmBuckets(ctx.db, {
			organizationId: args.organizationId,
			cell: cellKey,
			arm: 'reference',
			...window,
		});
		for (const bucket of referenceBuckets) {
			if (!Number.isFinite(bucket.periodStart)) continue;
			reference.set(
				bucket.periodStart,
				(reference.get(bucket.periodStart) ?? 0) + safeOutcomeCount(bucket.sent)
			);
		}
	}
	const points: IndependenceDayPoint[] = [];
	for (let day = args.sinceDay; day < args.untilDay; day += DAY_MS) {
		// EVERY DAY IS EMITTED, including the quiet ones. A series with holes
		// punched out of it renders as continuous traffic and makes a fortnight's
		// silence look like a fortnight's sending.
		points.push({ day, own: own.get(day) ?? 0, reference: reference.get(day) ?? 0 });
	}
	return points;
}

/** Every cell's ramp position, for the relay-removal safety check. */
async function readCellPositions(
	ctx: QueryCtx,
	organizationId: string
): Promise<RelayRemovalCellState[]> {
	const rows = await ctx.db
		.query('deliverabilityRouteStates')
		.withIndex('by_org_provider', (q) => q.eq('organizationId', organizationId))
		.take(128);
	const byCell = new Map<string, Doc<'deliverabilityRouteStates'>>();
	for (const row of rows) {
		if (row.stream === undefined) continue;
		byCell.set(`${row.stream}:${row.destinationProvider}`, row);
	}
	return allDeliverabilityCells().map((cell) => {
		const cellKey = deliverabilityCellKey(cell);
		const row = byCell.get(cellKey) ?? null;
		return {
			cellKey,
			stream: cell.stream,
			ownShare: resolveOwnShare(row),
			graduatedAt: row?.graduatedAt,
		};
	});
}

// all-members: aggregate own-vs-relay send volumes and the ramp's own position
// for the caller's organization. No credentials, no recipient identities, no
// cross-tenant reach — the organization comes from the session, not from args.
export const getIndependenceSummary = authedQuery({
	// No arguments: the window is the screen's, and a caller-chosen one would
	// silently change what the headline percentage means.
	args: {},
	handler: async (ctx): Promise<IndependenceSummary> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const now = Date.now();
		const untilDay = utcDayStart(now) + DAY_MS;
		const sinceDay = untilDay - INDEPENDENCE_WINDOW_DAYS * DAY_MS;
		const referenceTransportId = await referenceRelayTransportId(ctx);
		const hasReferenceArm = referenceTransportId !== null;
		const series = await readIndependenceSeries(ctx, {
			organizationId,
			sinceDay,
			untilDay,
			hasReferenceArm,
		});
		const projection = projectIndependenceDate({
			points: series,
			now,
			hasReferenceTransport: hasReferenceArm,
		});
		const cells = await readCellPositions(ctx, organizationId);
		const monthToDateOwnSends = ownSendsSince(series, utcMonthStart(now));
		// THE PRICE IS AN OPERATOR'S, NOT OURS. Until a deployment records what its
		// relay costs, the money figure is absent and the screen says why — a rate
		// the product invented would be quoted back at us as fact.
		const minorUnitsPerThousand = null;
		const capacityProjection = await loadWarmingCapacity(ctx, { now });
		return {
			generatedAt: now,
			referenceTransportId,
			ownShare: independenceShare(series),
			series,
			projection,
			spendAvoidedMinorUnits: spendAvoidedMinorUnits({
				ownSends: monthToDateOwnSends,
				minorUnitsPerThousand,
			}),
			spendAvoidedCurrency: null,
			monthToDateOwnSends,
			relayRemoval: hasReferenceArm
				? assessRelayRemoval({ cells, projection })
				: // Nothing to remove, so nothing to warn about. Not an error, not a
					// "setup incomplete": this is the supported standalone shape (D2).
					{ kind: 'safe' },
			capacity: {
				remainingToday: capacityProjection?.remainingToday ?? null,
				projectedDays: capacityProjection?.byDay ?? [],
			},
		};
	},
});
