/**
 * THE OBSERVATION SEAM, AGAINST REAL ROWS (plan D2, D3, D12).
 *
 * `delivery/ramp/` is pure and its suites inject presence maps and evidence
 * objects. That leaves one thing uncovered and it is the thing this piece is
 * measured on: whether the deployment's ACTUAL tables answer "is this
 * integration connected?" and "what evidence does this cell have?" the way the
 * pure rules assume. A substitution table driven by a reader that never notices
 * a revoked key is a substitution table that never substitutes.
 *
 * So every reader here is exercised against rows the shipped writers produce,
 * including the boundaries: the freshness edge, a truncated decision scan, an
 * incident recorded under a reason that is not `dnsbl`, and a cell with no data.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { MS_PER_DAY } from '../../lib/constants';
import { startOfDayUtc } from '../../lib/clock';
import {
	loadRampDeploymentPresence,
	loadReferenceArmPresence,
	RAMP_INTEGRATION_FRESHNESS_MS,
	RAMP_REFERENCE_ARM_WINDOW_MS,
} from '../rampIntegrationPresence';
import { loadRampPromotionEvidence } from '../rampPromotionEvidence';
import { resolveRampDegradation } from '../ramp/degradation';
import { RAMP_FULLY_EQUIPPED } from '../ramp/degradationMatrix';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import { PROMOTION_DNSBL_CLEAN_DAYS } from '../ramp/phasePromotion';
import { seedArmOutcomes, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_readers';
/**
 * THE REAL CLOCK, on purpose: the outcome fixtures bucket by `startOfDayUtc` of
 * the wall clock, so a suite pinned to an invented instant would seed its
 * traffic into a day the readers do not look at.
 */
const NOW = Date.now();
const CELL: DeliverabilityCell = { stream: 'campaign', destinationProvider: 'gmail' };

const EQUIPPED_DEGRADATION = resolveRampDegradation({
	presence: RAMP_FULLY_EQUIPPED,
	provider: 'gmail',
});

/** A route-state row for the cell, which the evidence reader anchors dwell on. */
async function seedCellRow(t: Harness, phaseCeilingSince?: number): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail' as const,
			stream: 'campaign' as const,
			isFallbackActive: false,
			ownShare: 0.5,
			phaseCeiling: 0.5,
			...(phaseCeilingSince === undefined ? {} : { phaseCeilingSince }),
			signals: [],
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + MS_PER_DAY,
			updatedAt: NOW,
		});
	});
}

async function cellRow(t: Harness) {
	const row = await t.run(async (ctx) => await ctx.db.query('deliverabilityRouteStates').first());
	if (row === null) throw new Error('fixture missing the cell row');
	return row;
}

/**
 * THE CLOCK IS READ AT CALL TIME, not pinned at module load.
 *
 * `NOW` is fixed when this file is imported, but the fixtures insert their rows
 * afterwards — so a row's `_creationTime` is AHEAD of `NOW`. The dwell anchor
 * falls back to `_creationTime`, and an anchor ahead of the clock is correctly
 * reported as unmeasured, which would make the legacy-row case exercise the
 * future-anchor guard instead of the fallback it is written for.
 */
async function evidence(t: Harness, now: number = Date.now()) {
	const perStream = await cellRow(t);
	return await t.run(
		async (ctx) =>
			await loadRampPromotionEvidence(ctx, {
				organizationId: ORG,
				cell: CELL,
				perStream,
				degradation: EQUIPPED_DEGRADATION,
				now,
			})
	);
}

async function presence(t: Harness) {
	return await t.run(
		async (ctx) => await loadRampDeploymentPresence(ctx, { organizationId: ORG, now: NOW })
	);
}

/** A seed mailbox account, the foreign key every probe row needs. */
async function seedAccount(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_readers',
			organizationId: ORG,
			kind: 'external' as const,
			address: 'seed@probe.example',
			domain: 'probe.example',
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
		await ctx.db.insert('externalMailAccounts', {
			userId: 'user_readers',
			organizationId: ORG,
			mailboxId,
			imapHost: 'imap.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: 'seed@probe.example',
			secretCiphertext: 'ct',
			secretIv: 'iv',
			secretAuthTag: 'tag',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

async function seedProbe(
	t: Harness,
	args: { sentAt: number; classifiedAt?: number }
): Promise<void> {
	await t.run(async (ctx) => {
		const account = await ctx.db.query('externalMailAccounts').first();
		if (account === null) throw new Error('fixture missing the seed account');
		await ctx.db.insert('seedPlacementProbes', {
			organizationId: ORG,
			probeId: `probe_${args.sentAt}`,
			accountId: account._id,
			provider: 'gmail' as const,
			stream: 'campaign' as const,
			sentAt: args.sentAt,
			dispatchedAt: args.sentAt,
			placement: 'inbox' as const,
			...(args.classifiedAt === undefined ? {} : { classifiedAt: args.classifiedAt }),
			expiresAt: args.sentAt + 90 * MS_PER_DAY,
		});
	});
}

/** One recorded controller decision, with the hard-stop signals it saw. */
async function seedDecision(
	t: Harness,
	args: {
		at: number;
		/** Deliberately NOT `dnsbl` in most cases — that is the point of the test. */
		reason: 'frozen' | 'holding' | 'dnsbl';
		isPoolBlocklisted: boolean;
		cell?: DeliverabilityCell;
	}
): Promise<void> {
	const cell = args.cell ?? CELL;
	await t.run(async (ctx) => {
		await ctx.db.insert('mixDecisions', {
			organizationId: ORG,
			cell: deliverabilityCellKey(cell),
			stream: cell.stream,
			destinationProvider: cell.destinationProvider,
			at: args.at,
			fromShare: 0.5,
			toShare: 0.5,
			direction: 'hold' as const,
			verdict: 'not_evaluated' as const,
			reason: args.reason,
			message: 'fixture',
			snapshot: JSON.stringify({
				signals: {
					isSendingAllowed: true,
					isCircuitBreakerOpen: false,
					isPoolBlocklisted: args.isPoolBlocklisted,
				},
			}),
			expiresAt: args.at + 90 * MS_PER_DAY,
		});
	});
}

describe('the presence reader answers from the deployment’s own rows', () => {
	it('finds nothing in a deployment with zero third-party accounts', async () => {
		const t = convexTest(schema, modules);
		expect(await presence(t)).toEqual({
			google_postmaster: false,
			microsoft_snds: false,
			seed_mailboxes: false,
			complaint_feedback_loop: false,
			commercial_placement_api: false,
		});
	});

	it('sees each feed the moment it produces a row', async () => {
		const t = convexTest(schema, modules);
		await seedAccount(t);
		await seedProbe(t, { sentAt: NOW - MS_PER_DAY });
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', {
				domain: 'readers.example',
				status: 'verified' as const,
				dnsRecords: {},
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('googlePostmasterStats', {
				domainId,
				domain: 'readers.example',
				periodStart: NOW - MS_PER_DAY,
				userReportedSpamRatio: 0.0001,
				fetchedAt: NOW - MS_PER_DAY,
				ingestedAt: NOW - MS_PER_DAY,
			});
			await ctx.db.insert('sndsIpDailyStats', {
				ip: '203.0.113.10',
				periodStart: NOW - MS_PER_DAY,
				complaintBand: 'lt_0_1' as const,
				filterResult: 'green' as const,
				trapHits: 0,
				messageRecipients: 1000,
				rcptCommands: 1000,
				dataCommands: 1000,
				fetchedAt: NOW - MS_PER_DAY,
				ingestedAt: NOW - MS_PER_DAY,
			});
			await ctx.db.insert('yahooCflEnrollments', {
				organizationId: ORG,
				domainId,
				state: 'enrolled' as const,
				createdAt: NOW,
				updatedAt: NOW,
			});
		});

		expect(await presence(t)).toMatchObject({
			google_postmaster: true,
			microsoft_snds: true,
			seed_mailboxes: true,
			complaint_feedback_loop: true,
		});
	});

	/**
	 * THE ACCEPTANCE BOUNDARY. The piece's criterion is that a removed
	 * integration degrades "within one window", and the window is
	 * `RAMP_AIMD.evaluationWindowMs`. A freshness horizon measured in weeks would
	 * keep the equipped constants for dozens of windows after a key was revoked,
	 * which is how the degraded path rots unobserved.
	 */
	it('is a small multiple of the daily feeds’ cadence, not weeks', () => {
		expect(RAMP_INTEGRATION_FRESHNESS_MS).toBeLessThanOrEqual(3 * RAMP_AIMD.evaluationWindowMs);
		expect(RAMP_INTEGRATION_FRESHNESS_MS).toBeGreaterThan(RAMP_AIMD.evaluationWindowMs);
	});

	it('stops seeing a feed the moment its newest row falls outside the window', async () => {
		const t = convexTest(schema, modules);
		await seedAccount(t);
		// Inside by a millisecond: still connected.
		await seedProbe(t, { sentAt: NOW - RAMP_INTEGRATION_FRESHNESS_MS + 1 });
		expect((await presence(t)).seed_mailboxes).toBe(true);

		await t.run(async (ctx) => {
			const probe = await ctx.db.query('seedPlacementProbes').first();
			if (probe === null) throw new Error('fixture missing the probe');
			// One millisecond older: the feed reads as gone, with no operator action
			// and no migration — which is what makes the substitution automatic.
			await ctx.db.patch(probe._id, { sentAt: NOW - RAMP_INTEGRATION_FRESHNESS_MS - 1 });
		});
		expect((await presence(t)).seed_mailboxes).toBe(false);
	});

	it('reads the cell’s reference arm over the same window the controller does', async () => {
		const t = convexTest(schema, modules);
		const has = async () =>
			await t.run(
				async (ctx) =>
					await loadReferenceArmPresence(ctx, { organizationId: ORG, cell: CELL, now: Date.now() })
			);
		expect(await has()).toBe(false);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 400 });
		expect(await has()).toBe(true);
		expect(RAMP_REFERENCE_ARM_WINDOW_MS).toBe(RAMP_AIMD.evaluationWindowMs);
	});
});

describe('the promotion-evidence reader', () => {
	it('reports every field as unmeasured in an empty deployment', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		const loaded = await evidence(t);
		expect(loaded.googleCompliancePassAt).toBeNull();
		expect(loaded.sndsBandGreenAt).toBeNull();
		expect(loaded.seedProbePassAt).toBeNull();
		expect(loaded.dnsblDays).toEqual([]);
		expect(loaded.worstCellDeferralRate).toBeNull();
	});

	/**
	 * THE CLEAN-DAY DERIVATION, WHICH MUST NOT READ THE WINNING REASON.
	 *
	 * A real blocklist incident spends most of its life under a FREEZE, whose
	 * decision reason is `frozen`, not `dnsbl`. Inferring the day's cleanliness
	 * from the winner would therefore score the incident as clean days — and the
	 * streak it feeds unlocks the most expensive rung on the ladder.
	 */
	it('scores a day dirty from the recorded signal even when another rung won', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		const day = startOfDayUtc(NOW - MS_PER_DAY);
		await seedDecision(t, { at: day + 1000, reason: 'frozen', isPoolBlocklisted: true });
		const loaded = await evidence(t);
		expect(loaded.dnsblDays).toEqual([{ dayStart: day, clean: false }]);
	});

	it('scores a day clean only when every decision that day saw a clean pool', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		const day = startOfDayUtc(NOW - MS_PER_DAY);
		await seedDecision(t, { at: day + 1000, reason: 'holding', isPoolBlocklisted: false });
		await seedDecision(t, { at: day + 2000, reason: 'holding', isPoolBlocklisted: false });
		expect((await evidence(t)).dnsblDays).toEqual([{ dayStart: day, clean: true }]);

		await seedDecision(t, { at: day + 3000, reason: 'holding', isPoolBlocklisted: true });
		expect((await evidence(t)).dnsblDays).toEqual([{ dayStart: day, clean: false }]);
	});

	/**
	 * TRUNCATION MUST DROP THE OLDEST DAYS, never the newest: an ascending scan
	 * that hit its page size would hand the rule a run of clean days that ended
	 * weeks ago — exactly the shape a stale-evidence pass is made of.
	 */
	it('keeps the newest days when the decision scan is truncated', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		const today = startOfDayUtc(NOW);
		// Far more rows than the reader's bounded page, spread over the window — in
		// ONE transaction, because 700 round trips is a fixture, not a test.
		await t.run(async (ctx) => {
			for (let index = 0; index < 700; index += 1) {
				const dayOffset = index % PROMOTION_DNSBL_CLEAN_DAYS;
				const at = today - dayOffset * MS_PER_DAY + index;
				await ctx.db.insert('mixDecisions', {
					organizationId: ORG,
					cell: deliverabilityCellKey(CELL),
					stream: CELL.stream,
					destinationProvider: CELL.destinationProvider,
					at,
					fromShare: 0.5,
					toShare: 0.5,
					direction: 'hold' as const,
					verdict: 'not_evaluated' as const,
					reason: 'holding' as const,
					message: 'fixture',
					snapshot: JSON.stringify({ signals: { isPoolBlocklisted: false } }),
					expiresAt: at + 90 * MS_PER_DAY,
				});
			}
		});
		const days = (await evidence(t)).dnsblDays.map((entry) => entry.dayStart);
		expect(days).toContain(today);
	});

	it('walks EVERY cell for the worst deferral rate, not just this one', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		// This cell is all but spotless; a different cell entirely is deferring
		// hard. Both carry a recorded deferral, so both are readable and the fold
		// is judged on the rates rather than on the instrument.
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 1000,
			counters: { delivered: 999, deferred: 1 },
		});
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 1000,
			destinationProvider: 'yahoo',
			counters: { delivered: 500, deferred: 500 },
		});
		expect((await evidence(t)).worstCellDeferralRate).toBeCloseTo(0.5, 10);
	});

	it('reads a cell nothing records deferrals for as UNMEASURED, not as a clean 0%', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		// Ample traffic through two cells, and not one deferral counted anywhere:
		// the shape of every deployment before the counter had a writer. Folding it
		// to `0` satisfied "deferral rate under threshold in EVERY cell" on the most
		// expensive rung of the ladder, off a measurement nobody took.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 5000 });
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 5000,
			destinationProvider: 'yahoo',
		});
		expect((await evidence(t)).worstCellDeferralRate).toBeNull();

		// PER CELL, exactly as gate 2 asks it (`hasUsableDeferralTelemetry`). A
		// third cell's deferral vouches for that cell and no other: the promotion
		// rule and the gate must not hold two notions of "instrumented", or a screen
		// and a controller end up disagreeing about one cell.
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 100,
			destinationProvider: 'apple',
			counters: { delivered: 99, deferred: 1 },
		});
		expect((await evidence(t)).worstCellDeferralRate).toBeNull();

		for (const destinationProvider of ['gmail', 'yahoo'] as const) {
			await seedArmOutcomes(t, {
				organizationId: ORG,
				arm: 'own',
				sent: 0,
				destinationProvider,
				counters: { delivered: 0, deferred: 1 },
			});
		}
		expect((await evidence(t)).worstCellDeferralRate).toBeCloseTo(0.01, 10);
	});

	/**
	 * THE INSTRUMENT AND THE RATE ARE JUDGED OVER DIFFERENT SPANS, and this is the
	 * case that proves it. The rate is the 24h window gate 2 decides on; the
	 * instrument is the 30-day span. Asking both over 24h made a fully instrumented,
	 * spotless grid unpromotable on any day nothing happened to get deferred — the
	 * mirror of `rampControllerHardStops`' own "weeks before the window it judges".
	 */
	it('decides gate 2 on a deferral recorded weeks before the window it judges', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 5000 });
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 10,
			dayOffset: 21,
			counters: { delivered: 9, deferred: 1 },
		});

		// A spotless day, and it reads as spotless rather than as unmeasured: the
		// counter demonstrably has a writer here, three weeks ago or not.
		expect((await evidence(t)).worstCellDeferralRate).toBe(0);
	});

	/**
	 * AND THE HOLD HAS AN EXIT. A deployment whose warm-up overflow routes to a
	 * relay never defers at all: with no exit, `null` here would be permanent and
	 * the standalone promotion route could never be satisfied, which is exactly
	 * what plan D2 forbids an absent signal from doing.
	 */
	it('reads a long observed zero as a reading once the arm has sent across the whole span', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 5000 });
		expect((await evidence(t)).worstCellDeferralRate).toBeNull();

		// The same cell, sending on the oldest day the 30-day read can see. Thirty
		// days of traffic and not one deferral is a silence this deployment has
		// observed, not one it failed to instrument.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 10, dayOffset: 30 });
		expect((await evidence(t)).worstCellDeferralRate).toBe(0);
	});

	it('reads a classified seed probe for THIS cell’s provider only', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t, NOW - 30 * MS_PER_DAY);
		await seedAccount(t);
		// Sent and classified inside the week the rule judges.
		await seedProbe(t, { sentAt: NOW - 2 * MS_PER_DAY, classifiedAt: NOW - MS_PER_DAY });
		expect((await evidence(t)).seedProbePassAt).toBe(NOW - MS_PER_DAY);

		// An unclassified probe is not evidence of anything.
		await t.run(async (ctx) => {
			const probe = await ctx.db.query('seedPlacementProbes').first();
			if (probe === null) throw new Error('fixture missing the probe');
			await ctx.db.patch(probe._id, { classifiedAt: undefined });
		});
		expect((await evidence(t)).seedProbePassAt).toBeNull();
	});

	/**
	 * A LEGACY ROW MUST NOT BE PERMANENTLY UNPROMOTABLE (plan D2). Rows that
	 * reached their rung before the dwell anchor existed carry none, and for a
	 * provider with no external promotion route the dwell is one of the only four
	 * conditions there are.
	 */
	it('anchors the dwell on the row’s creation when no anchor was ever stamped', async () => {
		const t = convexTest(schema, modules);
		await seedCellRow(t);
		// The row genuinely carries no anchor — otherwise this would assert nothing.
		expect((await cellRow(t)).phaseCeilingSince).toBeUndefined();
		const loaded = await evidence(t);
		expect(loaded.ceilingHeldMs).not.toBeNull();
		expect(loaded.ceilingHeldMs ?? -1).toBeGreaterThanOrEqual(0);
	});
});
