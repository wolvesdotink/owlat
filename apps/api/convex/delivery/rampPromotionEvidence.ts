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
import { DAY_MS } from '../lib/constants';
import { startOfDayUtc } from '../lib/clock';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import {
	deferralTelemetryReadSince,
	hasUsableDeferralTelemetry,
	summarizeTransportOutcomeBuckets,
} from '../analytics/transportOutcomeSummary';
import { complaintBandSeverity } from './sndsFeed';
import type { RampReadCtx } from './rampReadCtx';
import { RAMP_AIMD } from './ramp/controllerConfig';
import { RAMP_GATE_THRESHOLDS } from './ramp/gateConfig';
import { PROMOTION_BASE_DWELL_MS, type RampPromotionEvidence } from './ramp/phasePromotion';
import type { RampDegradation } from './ramp/degradation';

/** How far back the evidence readers look. One week, the plan's window. */
const EVIDENCE_WINDOW_MS = 7 * DAY_MS;
/** DNSBL day coverage the streak condition needs. Two weeks, plus slack. */
const DNSBL_WINDOW_MS = 21 * DAY_MS;
/** Bounded scans — a promotion must never be able to read an unbounded table. */
const SCAN_LIMIT = 64;
const DECISION_SCAN_LIMIT = 600;
/**
 * The largest verified-domain population the compliance reader will JUDGE. It
 * reads one row beyond this to detect its own truncation and answers `null`
 * rather than folding a partial subset — see `latestGoogleCompliancePassAt`.
 */
const DOMAIN_SCAN_LIMIT = 256;

/** The lowest SNDS complaint band — anything worse is not a green band. */
const SNDS_GREEN_SEVERITY = 0;

/** The newest passing Compliance Status reading for ONE domain, or `null`. */
async function domainCompliancePassAt(
	ctx: RampReadCtx,
	domain: string,
	since: number
): Promise<number | null> {
	const rows = await ctx.db
		.query('googlePostmasterCompliance')
		.withIndex('by_domain_period', (q) => q.eq('domain', domain).gte('periodStart', since))
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

/**
 * When EVERY VERIFIED SENDING DOMAIN IN THE DEPLOYMENT last read as compliant at
 * Google — per domain, folded with a MINIMUM.
 *
 * Google's Compliance Status is a per-domain verdict, so a deployment-wide
 * `by_period` scan would let one healthy domain's pass promote a cell whose mail
 * leaves on a different, failing domain. The invariant is therefore TOTAL: a
 * domain with no passing reading yields `null` for the whole deployment, because
 * an unread domain is not a passing one.
 *
 * WHICH MEANS THE READ MUST COVER THE WHOLE POPULATION IT CLAIMS TO JUDGE. This
 * is the evidence route for crossing the 0.5 rung on the gmail cell — the most
 * expensive promotion the ladder has — and a plain `.take(N)` made the invariant
 * quietly stop holding at domain N + 1, letting an arbitrary partial subset
 * satisfy it. That is fail-OPEN in the one place we cannot afford it.
 *
 * So the scan reads ONE MORE ROW THAN IT WILL ACCEPT and treats an overflow as
 * an unread population — `null`, "not a pass". Either the read saw every
 * verified domain and the fold is exact, or it did not and it says so. A
 * promotion must never read an unbounded table, and the only bounded answer that
 * does not invent a verdict is the one that fails CLOSED.
 *
 * Absence is still never a block (plan D2): `null` here costs the `google_
 * compliance` route, and the standalone route is unaffected.
 */
async function latestGoogleCompliancePassAt(
	ctx: RampReadCtx,
	since: number
): Promise<number | null> {
	const domains = await ctx.db
		.query('domains')
		.withIndex('by_status', (q) => q.eq('status', 'verified'))
		.take(DOMAIN_SCAN_LIMIT + 1);
	// NO VERIFIED DOMAIN AT ALL is not a pass either — there is no reading to
	// promote on, which is the same answer as an unread one.
	if (domains.length === 0 || domains.length > DOMAIN_SCAN_LIMIT) return null;

	// THE POPULATION IS KNOWN UP FRONT AND EVERY READ IS INDEPENDENT, so the
	// per-domain readings are issued together rather than as N serialized
	// round-trips. The fold below is unchanged, and so is its fail-CLOSED rule.
	const perDomain = await Promise.all(
		domains.map((domain) => domainCompliancePassAt(ctx, domain.domain, since))
	);

	let oldest: number | null = null;
	for (const latest of perDomain) {
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
async function latestSndsGreenBandAt(ctx: RampReadCtx, since: number): Promise<number | null> {
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

/**
 * WHEN THIS CELL'S PROBES LAST LANDED CLEAN — scoped to the WHOLE cell key.
 *
 * Both axes are filtered, because the caller asks per cell. The stream filter
 * was a no-op while every probe was a campaign probe (`delivery/seedShadowCopy.ts`
 * was the only writer); now that `delivery/seedScheduledProbe.ts` writes the
 * other two streams, an unfiltered read would let one stream's clean sweep serve
 * as another's promotion evidence — the same lending gate 5 refuses, arriving
 * through the promotion door instead.
 *
 * An absent reading is `null`, which reports `unknown` and never PERMANENTLY
 * blocks a promotion (plan D2) — so narrowing here costs a cell nothing but the
 * borrowed claim.
 */
async function latestSeedProbePassAt(
	ctx: RampReadCtx,
	args: {
		organizationId: string;
		since: number;
		cell: DeliverabilityCell;
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
		if (row.provider !== args.cell.destinationProvider || row.stream !== args.cell.stream) {
			continue;
		}
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
	ctx: RampReadCtx,
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
		const day = startOfDayUtc(row.at);
		const listed = snapshotPoolBlocklisted(row.snapshot);
		const clean = listed === false && (byDay.get(day) ?? true);
		byDay.set(day, clean);
	}
	return [...byDay.entries()].map(([dayStart, clean]) => ({ dayStart, clean }));
}

/**
 * The worst own-arm deferral rate across EVERY cell in the grid, or `null` when
 * a cell that is sending cannot say whether its zero is a reading.
 *
 * The null is the point. `deferred` is only partly instrumented (see
 * `delivery/deferralOutcome.ts`), and a cell whose counter has no writer folds
 * to a rate of `0` — under every ceiling, `met`, and the plan's "deferral rate
 * under threshold in EVERY cell" condition satisfied by a measurement nobody
 * took, on the rung that costs the most to get wrong.
 *
 * TWO SPANS, ONE READ, and that is the whole shape of this function. The RATE is
 * the 24h evaluation window the controller judges gate 2 over — anything wider
 * would answer a different question than the gate does. The INSTRUMENT is judged
 * over the telemetry span, through the same `hasUsableDeferralTelemetry` the gate
 * and the dashboard ask, because a quiet Tuesday is not the same fact as a cell
 * nothing records deferrals for. Asking the instrument over the 24h window made a
 * spotless, fully instrumented grid unpromotable on any day nothing happened to
 * get deferred.
 *
 * A CELL WITH NO SENDS IN THE WINDOW IS SKIPPED, not held: it contributes no rate
 * to a worst-of, and demanding an instrument reading from a cell that sent
 * nothing would make the grid's quietest corner veto every promotion. What DOES
 * null the grid is a cell sending today whose traffic has not yet spread across
 * the telemetry span — a young cell, never a quiet day, since the predicate reads
 * the span rather than its oldest day.
 */
async function worstCellDeferralRate(
	ctx: RampReadCtx,
	args: { organizationId: string; now: number }
): Promise<number | null> {
	// FIFTEEN INDEPENDENT SHARDED READS, issued together. Each one is itself
	// several shard reads, so serializing them made one promotion serialize
	// several hundred round-trips. Both spans are derived from the rows they
	// return, so the read has to cover the wider one.
	//
	// THE NUMBER, because "bounded" stopped being the useful word here: 15 cells
	// (3 streams × 5 destination providers) × up to 30 day-buckets
	// (`DEFERRAL_TELEMETRY_SPAN_MS`) × `TRANSPORT_OUTCOME_SHARD_COUNT` = 8 shards
	// ≈ 3,600 documents in ONE mutation, against ~120 when this read was a 24h
	// summary. That is comfortably inside Convex's per-transaction read limit and
	// `promoteCellPhase` runs for one cell at a time, so it is headroom rather
	// than a defect — but widening either span, or the shard count, multiplies
	// against the other two, and the next change should be made with the figure
	// in view rather than rediscovering it.
	const spanStart = deferralTelemetryReadSince(args.now);
	const perCell = await Promise.all(
		allDeliverabilityCells().map((cell) =>
			readCellArmBuckets(ctx.db, {
				organizationId: args.organizationId,
				cell: deliverabilityCellKey(cell),
				arm: 'own',
				since: spanStart,
			})
		)
	);

	let worst: number | null = null;
	for (const buckets of perCell) {
		const summary = summarizeTransportOutcomeBuckets(buckets, {
			since: args.now - RAMP_AIMD.evaluationWindowMs,
		});
		if (summary.sent <= 0) continue;
		if (!hasUsableDeferralTelemetry(buckets, args.now)) return null;
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
	ctx: RampReadCtx,
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
	// `phaseCeilingSince` is stamped only by the writes that SET a rung (enrolment,
	// a promotion, a downward phase reset), so a row that arrived at a rung any
	// other way — seeded, hand-patched, or written before this column existed —
	// carries none. For a provider with no external route
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
	// FIVE INDEPENDENT EVIDENCE READS — none of them feeds another, so they are
	// issued together rather than one after the next.
	const [
		googleCompliancePassAt,
		sndsBandGreenAt,
		seedProbePassAt,
		dnsblDayReadings,
		worstDeferralRate,
	] = await Promise.all([
		latestGoogleCompliancePassAt(ctx, since),
		latestSndsGreenBandAt(ctx, since),
		latestSeedProbePassAt(ctx, { organizationId, since, cell }),
		dnsblDays(ctx, { organizationId, cell, now }),
		worstCellDeferralRate(ctx, { organizationId, now }),
	]);
	return {
		googleCompliancePassAt,
		sndsBandGreenAt,
		seedProbePassAt,
		// UNKNOWN, NOT ZERO, when the anchor is degenerate or ahead of the clock: a
		// dwell nobody could measure must not read as a dwell nobody served, and it
		// must not read as one served either.
		ceilingHeldMs: !Number.isFinite(heldSince) || heldSince > now ? null : now - heldSince,
		requiredDwellMs: PROMOTION_BASE_DWELL_MS * degradation.dwellMultiplier,
		dnsblDays: dnsblDayReadings,
		worstCellDeferralRate: worstDeferralRate,
		deferralMax: RAMP_GATE_THRESHOLDS.deferralMax,
	};
}
