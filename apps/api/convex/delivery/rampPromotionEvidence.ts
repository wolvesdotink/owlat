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
import type { DatabaseReader } from '../_generated/server';
import { summarizeTransportOutcomes } from '../analytics/transportOutcomes';
import { complaintBandSeverity } from './sndsFeed';
import { RAMP_AIMD } from './ramp/controllerConfig';
import { RAMP_GATE_THRESHOLDS } from './ramp/gateConfig';
import { PROMOTION_BASE_DWELL_MS, type RampPromotionEvidence } from './ramp/phasePromotion';
import type { RampDegradation } from './ramp/degradation';

/**
 * READER-TYPED (ADR-0042). Everything below observes and nothing writes, so the
 * handle is a `DatabaseReader` rather than a mutation context: the dashboard
 * query and the controller must be able to read the SAME evidence through the
 * same functions, or they will eventually disagree about a number.
 */
export interface RampEvidenceReader {
	readonly db: DatabaseReader;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the evidence readers look. One week, the plan's window. */
const EVIDENCE_WINDOW_MS = 7 * DAY_MS;
/** DNSBL day coverage the streak condition needs. Two weeks, plus slack. */
const DNSBL_WINDOW_MS = 21 * DAY_MS;
/** Bounded scans — a promotion must never be able to read an unbounded table. */
const SCAN_LIMIT = 64;
const DECISION_SCAN_LIMIT = 600;
/** Verified sending domains considered when reading Google's compliance verdict. */
const DOMAIN_SCAN_LIMIT = 32;

/** The lowest SNDS complaint band — anything worse is not a green band. */
const SNDS_GREEN_SEVERITY = 0;

function utcDayStart(at: number): number {
	return Math.floor(at / DAY_MS) * DAY_MS;
}

/**
 * When every VERIFIED SENDING DOMAIN last read as compliant at Google.
 *
 * SCOPED TO THE DOMAINS THAT CARRY THE TRAFFIC, per domain, and folded with a
 * MINIMUM. Google's Compliance Status is a per-domain verdict, so a deployment-
 * wide `by_period` scan would let one healthy domain's pass promote a cell whose
 * mail leaves on a different, failing domain. A domain with no reading at all
 * yields `null` for the whole deployment — an unread domain is not a passing one.
 *
 * Bounded: a handful of verified domains, one bounded index read each.
 */
async function latestGoogleCompliancePassAt(
	ctx: RampEvidenceReader,
	since: number
): Promise<number | null> {
	const domains = await ctx.db
		.query('domains')
		.withIndex('by_status', (q) => q.eq('status', 'verified'))
		.take(DOMAIN_SCAN_LIMIT);
	if (domains.length === 0) return null;

	let oldest: number | null = null;
	for (const domain of domains) {
		const rows = await ctx.db
			.query('googlePostmasterCompliance')
			.withIndex('by_domain_period', (q) => q.eq('domain', domain.domain).gte('periodStart', since))
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
		if (latest === null) return null;
		oldest = oldest === null ? latest : Math.min(oldest, latest);
	}
	return oldest;
}

/**
 * DELIBERATELY DEPLOYMENT-WIDE, unlike the Google reader above.
 *
 * SNDS reports per POOL IP, and the pool is a property of the deployment rather
 * than of a cell or a domain: every cell's own arm leaves from the same
 * addresses. So "the relevant cell" and "this deployment's pool" are the same
 * scope here, and the asymmetry with the per-domain Google read is intended.
 */
async function latestSndsGreenBandAt(
	ctx: RampEvidenceReader,
	since: number
): Promise<number | null> {
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
	ctx: RampEvidenceReader,
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
 * Read the pool-blocklist SIGNAL out of a recorded decision's snapshot.
 *
 * `null` when the snapshot cannot be read as one — a row we cannot interpret is
 * not a clean reading, and the caller treats it as a dirty day rather than as
 * one more day of the streak.
 */
function snapshotPoolBlocklisted(snapshot: string | undefined): boolean | null {
	if (snapshot === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(snapshot);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const signals = (parsed as { signals?: unknown }).signals;
	if (typeof signals !== 'object' || signals === null) return null;
	const listed = (signals as { isPoolBlocklisted?: unknown }).isPoolBlocklisted;
	return typeof listed === 'boolean' ? listed : null;
}

/**
 * Pool-wide DNSBL days, derived from the controller's OWN audit trail.
 *
 * READ FROM THE RECORDED SIGNAL, NEVER FROM THE WINNING REASON. `mixDecisions`
 * records every evaluation including the no-ops, each with a snapshot of every
 * gate's inputs (plan D12) — and `dnsbl` is only ever the WINNING reason at its
 * own rung. The kill switch, a suspended org, an active freeze and the circuit
 * breaker all outrank it, and those are exactly the states a real listing
 * produces: the 24h freeze that FOLLOWS a critical listing is reason `frozen`,
 * so inferring cleanliness from the winner would score an entire blocklist
 * incident as clean days and unlock the most expensive rung on the ladder.
 * `signals.isPoolBlocklisted` is the reading itself and outranks nothing.
 *
 * A day with no row at all produces no entry, which the pure rule reads as
 * missing coverage rather than as a clean day — so a cell that was skipped or
 * unmanaged for a tick contributes no coverage, and a gap resets the streak.
 *
 * NEWEST FIRST: the scan is bounded, and truncating must drop the OLDEST days.
 * Ascending order would drop the newest and leave behind exactly the shape of a
 * stale clean run — which the pure rule now rejects, but which should never be
 * manufactured by a query's page size in the first place.
 */
async function dnsblDays(
	ctx: RampEvidenceReader,
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
		.order('desc')
		.take(DECISION_SCAN_LIMIT);
	const byDay = new Map<number, boolean>();
	for (const row of rows) {
		const day = utcDayStart(row.at);
		const listed = snapshotPoolBlocklisted(row.snapshot);
		const clean = listed === false && (byDay.get(day) ?? true);
		byDay.set(day, clean);
	}
	return [...byDay.entries()].map(([dayStart, clean]) => ({ dayStart, clean }));
}

/** The worst own-arm deferral rate across EVERY cell in the grid. */
async function worstCellDeferralRate(
	ctx: RampEvidenceReader,
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
	ctx: RampEvidenceReader,
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
	// THE DWELL ANCHOR, WITH A FALLBACK — because an absent reading must never
	// PERMANENTLY block a promotion (plan D2).
	//
	// `phaseCeilingSince` is stamped only by `promoteRampPhase`, so a row that
	// arrived at a rung any other way — seeded, hand-patched, or written before
	// this column existed — carries none. For a provider with no external route
	// (yahoo, apple, other) the standalone route is the ONLY one, dwell is one of
	// its four conditions, and `null` reports `unknown` for ever: the cell could
	// never be promoted again, by anyone, with no operator remedy.
	//
	// So the anchor falls back to the ROW'S CREATION instant — the earliest moment
	// the rung could possibly have been set, and a FIXED one. (`decidedAt` would
	// be the wrong fallback for exactly the opposite reason: the controller
	// restamps it every tick, so a dwell measured from it would restart hourly and
	// never be served at all.) `applyDecision` stamps the same value onto the row
	// the first time it manages one without an anchor, so reader and writer agree.
	const heldSince = perStream.phaseCeilingSince ?? perStream._creationTime;
	return {
		googleCompliancePassAt: await latestGoogleCompliancePassAt(ctx, since),
		sndsBandGreenAt: await latestSndsGreenBandAt(ctx, since),
		seedProbePassAt: await latestSeedProbePassAt(ctx, {
			organizationId,
			since,
			provider: cell.destinationProvider,
		}),
		// UNKNOWN, NOT ZERO, when the anchor is degenerate or ahead of the clock: a
		// dwell nobody could measure must not read as a dwell nobody served, and it
		// must not read as one served either.
		ceilingHeldMs: !Number.isFinite(heldSince) || heldSince > now ? null : now - heldSince,
		requiredDwellMs: PROMOTION_BASE_DWELL_MS * degradation.dwellMultiplier,
		dnsblDays: await dnsblDays(ctx, { organizationId, cell, now }),
		worstCellDeferralRate: await worstCellDeferralRate(ctx, { organizationId, now }),
		deferralMax: RAMP_GATE_THRESHOLDS.deferralMax,
	};
}
