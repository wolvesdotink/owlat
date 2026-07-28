/**
 * THE READ HALF OF THE PHASE-PROMOTION RULE (plan D3, D15).
 *
 * `delivery/ramp/phasePromotion.ts` owns the rule — the routes, the conditions
 * and the arithmetic — and is pure. This module loads the instants it judges.
 * Nothing here decides anything: it returns evidence, and every field it cannot
 * observe comes back `null`, which the pure rule reports as `unknown` rather
 * than as a pass.
 *
 * PROMOTION IS A RARE, DELIBERATE ACT, which is what makes the deferral read
 * below affordable: it walks every cell (fifteen bounded index reads) because
 * the plan's standalone route asks for "deferral rate under threshold in EVERY
 * cell, not just this one", and a cheaper approximation would answer a different
 * question.
 */

import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import { isSeedPlacementReached } from '@owlat/shared/seedPlacement';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { summarizeTransportOutcomes } from '../analytics/transportOutcomes';
import { complaintBandSeverity } from './sndsFeed';
import { RAMP_AIMD } from './ramp/controllerConfig';
import { RAMP_GATE_THRESHOLDS } from './ramp/gateConfig';
import { PROMOTION_BASE_DWELL_MS, type RampPromotionEvidence } from './ramp/phasePromotion';
import type { RampDegradation } from './ramp/degradation';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the evidence readers look. One week, the plan's window. */
const EVIDENCE_WINDOW_MS = 7 * DAY_MS;
/** DNSBL day coverage the streak condition needs. Two weeks, plus slack. */
const DNSBL_WINDOW_MS = 21 * DAY_MS;
/** Bounded scans — a promotion must never be able to read an unbounded table. */
const SCAN_LIMIT = 64;
const DECISION_SCAN_LIMIT = 600;

/** The lowest SNDS complaint band — anything worse is not a green band. */
const SNDS_GREEN_SEVERITY = 0;

function utcDayStart(at: number): number {
	return Math.floor(at / DAY_MS) * DAY_MS;
}

async function latestGoogleCompliancePassAt(
	ctx: MutationCtx,
	since: number
): Promise<number | null> {
	const rows = await ctx.db
		.query('googlePostmasterCompliance')
		.withIndex('by_period', (q) => q.gte('periodStart', since))
		.take(SCAN_LIMIT);
	let latest: number | null = null;
	for (const row of rows) {
		// A COMPLIANCE PASS IS EVERY CHECK PASSING. A row with no checks at all is
		// not a pass — an empty list would otherwise satisfy `every` vacuously and
		// promote a cell on a reading Google never made.
		if (row.checks.length === 0) continue;
		if (!row.checks.every((check) => check.state === 'passing')) continue;
		latest = latest === null ? row.fetchedAt : Math.max(latest, row.fetchedAt);
	}
	return latest;
}

async function latestSndsGreenBandAt(ctx: MutationCtx, since: number): Promise<number | null> {
	const rows = await ctx.db
		.query('sndsIpDailyStats')
		.withIndex('by_period', (q) => q.gte('periodStart', since))
		.take(SCAN_LIMIT);
	let latest: number | null = null;
	for (const row of rows) {
		const severity = complaintBandSeverity(row.complaintBand);
		if (severity === null || severity > SNDS_GREEN_SEVERITY) continue;
		latest = latest === null ? row.fetchedAt : Math.max(latest, row.fetchedAt);
	}
	return latest;
}

async function latestSeedProbePassAt(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		since: number;
		provider: DeliverabilityCell['destinationProvider'];
	}
): Promise<number | null> {
	const rows = await ctx.db
		.query('seedPlacementProbes')
		.withIndex('by_org_and_sent_at', (q) =>
			q.eq('organizationId', args.organizationId).gte('sentAt', args.since)
		)
		.take(SCAN_LIMIT);
	let latest: number | null = null;
	for (const row of rows) {
		if (row.provider !== args.provider) continue;
		// "REACHED", through the shipped predicate rather than a second taxonomy: a
		// Gmail Promotions tab is a delivered probe, and a local `=== 'inbox'` test
		// would quietly hold every promotion on a provider that categorises mail.
		if (row.placement === undefined || !isSeedPlacementReached(row.placement)) continue;
		const at = row.classifiedAt;
		if (at === undefined) continue;
		latest = latest === null ? at : Math.max(latest, at);
	}
	return latest;
}

/**
 * Pool-wide DNSBL days, derived from the controller's OWN audit trail.
 *
 * `mixDecisions` records every evaluation including the no-ops (plan D12), and a
 * critical pool listing is the `dnsbl` decision reason. So a day the controller
 * evaluated and never said `dnsbl` is a day every pool IP was clean — and a day
 * it did not evaluate at all produces no row, which the pure rule reads as
 * missing coverage rather than as a clean day. Deriving the streak from the
 * audit trail rather than from a second store is what keeps "what the operator
 * can read" and "what the promotion believed" the same fact.
 */
async function dnsblDays(
	ctx: MutationCtx,
	args: { organizationId: string; cell: DeliverabilityCell; now: number }
): Promise<{ dayStart: number; clean: boolean }[]> {
	const rows = await ctx.db
		.query('mixDecisions')
		.withIndex('by_org_cell_time', (q) =>
			q
				.eq('organizationId', args.organizationId)
				.eq('cell', deliverabilityCellKey(args.cell))
				.gte('at', args.now - DNSBL_WINDOW_MS)
		)
		.take(DECISION_SCAN_LIMIT);
	const byDay = new Map<number, boolean>();
	for (const row of rows) {
		const day = utcDayStart(row.at);
		const clean = row.reason !== 'dnsbl' && (byDay.get(day) ?? true);
		byDay.set(day, clean);
	}
	return [...byDay.entries()].map(([dayStart, clean]) => ({ dayStart, clean }));
}

/** The worst own-arm deferral rate across EVERY cell in the grid. */
async function worstCellDeferralRate(
	ctx: MutationCtx,
	args: { organizationId: string; now: number }
): Promise<number | null> {
	let worst: number | null = null;
	for (const cell of allDeliverabilityCells()) {
		const summary = await summarizeTransportOutcomes(ctx.db, {
			organizationId: args.organizationId,
			cell: deliverabilityCellKey(cell),
			arm: 'own',
			since: args.now - RAMP_AIMD.evaluationWindowMs,
		});
		if (summary.sent <= 0) continue;
		const rate = summary.deferralRate;
		if (!Number.isFinite(rate)) continue;
		worst = worst === null ? rate : Math.max(worst, rate);
	}
	return worst;
}

/**
 * Load everything the promotion rule judges for one cell.
 *
 * `requiredDwellMs` carries the substitution table's dwell multiplier (absent
 * Postmaster or SNDS doubles it), so the plan's "DWELL TIME x2" and the
 * standalone route's own doubling compose in the pure rule rather than being
 * multiplied together at two different call sites.
 */
export async function loadRampPromotionEvidence(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		cell: DeliverabilityCell;
		perStream: Doc<'deliverabilityRouteStates'>;
		degradation: RampDegradation;
		now: number;
	}
): Promise<RampPromotionEvidence> {
	const { organizationId, cell, perStream, degradation, now } = args;
	const since = now - EVIDENCE_WINDOW_MS;
	const heldSince = perStream.phaseCeilingSince;
	return {
		googleCompliancePassAt: await latestGoogleCompliancePassAt(ctx, since),
		sndsBandGreenAt: await latestSndsGreenBandAt(ctx, since),
		seedProbePassAt: await latestSeedProbePassAt(ctx, {
			organizationId,
			since,
			provider: cell.destinationProvider,
		}),
		// UNKNOWN, NOT ZERO, when the row predates the column or carries a
		// degenerate instant: a dwell nobody measured must not read as a dwell
		// nobody served, and it must not read as one served either.
		ceilingHeldMs:
			heldSince === undefined || !Number.isFinite(heldSince) || heldSince > now
				? null
				: now - heldSince,
		requiredDwellMs: PROMOTION_BASE_DWELL_MS * degradation.dwellMultiplier,
		dnsblDays: await dnsblDays(ctx, { organizationId, cell, now }),
		worstCellDeferralRate: await worstCellDeferralRate(ctx, { organizationId, now }),
		deferralMax: RAMP_GATE_THRESHOLDS.deferralMax,
	};
}
