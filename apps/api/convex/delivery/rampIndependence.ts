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
 * when nobody has recorded a relay price, and the projection is
 * `already_independent` rather than "unknown".
 *
 * THE PRICE COMES FROM SETTINGS, NOT FROM A NEW TABLE (plan D4). An admin
 * records what their relay charges per thousand messages on the existing
 * `instanceSettings` row (Settings → Delivery, and the Controls screen links
 * there); unset is the ordinary state and costs the screen one line of copy
 * rather than a warning.
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
	DAY_MS,
	type IndependenceDayPoint,
	type IndependenceProjection,
	type RelayRemovalCellState,
	type RelayRemovalSafety,
} from '@owlat/shared/deliverabilityIndependence';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import { safeOutcomeCount } from '../analytics/transportOutcomeSummary';
import { loadRouteStatesByCell } from '../lib/deliverabilityRouteState';
import { referenceRelayTransportId } from './alignmentPreflight';
import { loadWarmingCapacity } from './warmingCapacity';

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
	const window = { since: args.sinceDay, until: args.untilDay };
	// ONE PASS OVER THE ROWS, AND THE READS DO NOT QUEUE BEHIND EACH OTHER.
	// `transportOutcomes` is indexed `by_org_cell_arm_period_shard`, so a
	// cross-cell sweep is not expressible: the smallest read that answers this
	// screen is one bounded range per (cell, arm), and each of those rows is
	// visited exactly once by the per-day fold below (the note in
	// `analytics/transportOutcomes.ts` is about re-reading ONE cell's index per
	// window, which this does not do). What is available is concurrency — awaiting
	// them in a loop made thirty round trips serial for no reason.
	//
	// The reference arm is not read at all on a standalone deployment: there is no
	// second arm, so those fifteen ranges could only ever come back empty (D2).
	const reads = allDeliverabilityCells().flatMap((cell) => {
		const cellKey = deliverabilityCellKey(cell);
		const arms: readonly ('own' | 'reference')[] = args.hasReferenceArm
			? ['own', 'reference']
			: ['own'];
		return arms.map(async (arm) => ({
			arm,
			buckets: await readCellArmBuckets(ctx.db, {
				organizationId: args.organizationId,
				cell: cellKey,
				arm,
				...window,
			}),
		}));
	});
	for (const { arm, buckets } of await Promise.all(reads)) {
		const into = arm === 'own' ? own : reference;
		for (const bucket of buckets) {
			if (!Number.isFinite(bucket.periodStart)) continue;
			into.set(
				bucket.periodStart,
				(into.get(bucket.periodStart) ?? 0) + safeOutcomeCount(bucket.sent)
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
	const byCell = await loadRouteStatesByCell(ctx, organizationId);
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
		//
		// A price with no relay is also nothing to show: there is no relay spend to
		// avoid on a standalone deployment, whatever a stale settings row says.
		const settings = await ctx.db.query('instanceSettings').first();
		const storedPrice = settings?.relayMinorUnitsPerThousand;
		// BOTH HALVES OR NEITHER. A number with no currency cannot be rendered
		// honestly — its minor-unit exponent is a property of the currency — so an
		// amount without a code is treated exactly like no price at all rather than
		// formatted under a guessed one.
		const storedCurrency = settings?.relayCurrency;
		const hasPrice =
			hasReferenceArm &&
			storedPrice !== undefined &&
			Number.isFinite(storedPrice) &&
			storedPrice > 0 &&
			storedCurrency !== undefined &&
			storedCurrency !== '';
		const minorUnitsPerThousand = hasPrice ? (storedPrice ?? null) : null;
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
			spendAvoidedCurrency: hasPrice ? (storedCurrency ?? null) : null,
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
