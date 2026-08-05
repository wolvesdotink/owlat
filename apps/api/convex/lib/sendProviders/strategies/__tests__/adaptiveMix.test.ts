/**
 * `adaptive_mix` — THE SPLIT MATRIX.
 *
 * The controller writes a share and expects the traffic to follow it. If the
 * realised proportion drifts from the configured share, every rate the
 * controller derives is computed over the wrong denominators and the AIMD loop
 * is chasing a number that does not mean what it says.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../../../schema';
import { modules } from '../../../../__tests__/testModules';
import { sendProviderCatalogEntry } from '../../catalog';
import { armForTransport, recordSendAssignments } from '../../../../delivery/sendAssignments';
import {
	adaptiveMixStrategy,
	decideMixAssignment,
	MIX_BUCKET_SPACE,
	OWN_ARM_TRANSPORT_KIND,
} from '../adaptive_mix';
import {
	assignAll,
	assignRanked,
	ranksFromScores,
	shareOfArm,
	syntheticContactIds,
} from './fixtures';

const AUDIENCE = syntheticContactIds(20_000);
const SEND_IDS = syntheticContactIds(20_000, 'snd');
const SHARES = [0, 0.02, 0.5, 0.97, 1];

/** Distinct scores: every recipient has their own percentile. */
const DISTINCT_SCORES = AUDIENCE.map((_, index) => index / AUDIENCE.length);
/**
 * The realistic warming cohort: a long tie at the bottom (never opened, score
 * 0) with a distinct-ish tail. `engagementPercentile` gives every member of the
 * tied block the block's UPPER percentile, so without tie dispersion this
 * cohort sends its entire bottom 70% to the own arm at any s >= 0.3.
 */
const TIED_SCORES = AUDIENCE.map((_, index) => (index < AUDIENCE.length * 0.7 ? 0 : index % 40));
/** The most degenerate real list there is: nobody has engaged with anything. */
const ALL_ZERO_SCORES = AUDIENCE.map(() => 0);

describe('adaptive_mix — split matrix', () => {
	it.each(SHARES)('realises share %s within tolerance over a large audience', (ownShare) => {
		const assignments = assignAll(AUDIENCE, { ownShare, mixVersion: 1 }, { campaignId: 'cmp-1' });
		const realised = shareOfArm(assignments, 'own');
		// 1pp tolerance over 20k draws. The degenerate shares are exact by
		// construction (they short-circuit before the hash), so they are asserted
		// exactly rather than statistically.
		if (ownShare === 0 || ownShare === 1) expect(realised).toBe(ownShare);
		else expect(Math.abs(realised - ownShare)).toBeLessThan(0.01);
	});

	// THE SAME MATRIX ON THE STRATIFIED PATH. Stratification is the D8 default in
	// production, so a matrix that only exercises the random-bucket branch
	// asserts nothing about how the share is realised for real traffic — and the
	// tied cohorts below are the distributions where getting it wrong pushes
	// realised own volume far ABOVE the controller's set point.
	describe.each([
		['distinct scores', DISTINCT_SCORES, 0.02],
		['a mostly-tied cold cohort', TIED_SCORES, 0.03],
		['an all-zero cohort', ALL_ZERO_SCORES, 0.03],
	])('stratified over %s', (_label, scores, tolerance) => {
		const ranks = ranksFromScores(SEND_IDS, scores);

		it.each(SHARES)('realises share %s within tolerance', (ownShare) => {
			const assignments = assignRanked(
				AUDIENCE,
				ranks,
				{ ownShare, mixVersion: 1 },
				{
					campaignId: 'cmp-1',
				}
			);
			const realised = shareOfArm(assignments, 'own');
			if (ownShare === 0 || ownShare === 1) expect(realised).toBe(ownShare);
			else expect(Math.abs(realised - ownShare)).toBeLessThan(tolerance);
		});
	});

	it('actually takes the stratified branch when ranks are present', () => {
		// Guard the guard: if the ranker stopped producing ranks, every assertion
		// above would silently fall back to the random bucket and keep passing.
		const ranks = ranksFromScores(SEND_IDS, DISTINCT_SCORES);
		const assignments = assignRanked(
			AUDIENCE,
			ranks,
			{ ownShare: 0.5, mixVersion: 1 },
			{
				campaignId: 'cmp-1',
			}
		);
		const stratified = assignments.filter((a) => a.basis === 'stratified').length;
		expect(stratified).toBeGreaterThan(AUDIENCE.length * 0.85);
	});

	it('realises the share per campaign, not only in aggregate', () => {
		// A share that is only correct when averaged over campaigns is not a
		// usable control variable: the controller evaluates one window of one
		// cell, which is a handful of campaigns at most.
		for (const campaignId of ['cmp-a', 'cmp-b', 'cmp-c', 'cmp-d']) {
			const assignments = assignAll(AUDIENCE, { ownShare: 0.35, mixVersion: 4 }, { campaignId });
			expect(Math.abs(shareOfArm(assignments, 'own') - 0.35)).toBeLessThan(0.015);
		}
	});

	it('records the clamped share and the normalised version on every decision', () => {
		const decision = decideMixAssignment({
			cell: { ownShare: 1.4, mixVersion: 3.7 },
			recipient: { contactId: 'c1', campaignId: 'cmp' },
		});
		expect(decision.ownShare).toBe(1);
		expect(decision.mixVersion).toBe(3);
		// A share of 1 short-circuits above the hash, so there is no slot to
		// report — `null` says "never hashed" rather than "hashed to slot 0".
		expect(decision.bucket).toBeNull();
	});

	it('reports a real slot only on the branches that actually hash', () => {
		const hashed = decideMixAssignment({
			cell: { ownShare: 0.4, mixVersion: 2 },
			recipient: { contactId: 'c1', campaignId: 'cmp' },
		});
		expect(hashed.bucket).toBeGreaterThanOrEqual(0);
		expect(hashed.bucket).toBeLessThan(MIX_BUCKET_SPACE);

		// Both degenerate shares and the unidentifiable recipient decide the arm
		// without a hash, and all three say so.
		for (const decision of [
			decideMixAssignment({ cell: { ownShare: 0, mixVersion: 2 }, recipient: { contactId: 'c1' } }),
			decideMixAssignment({ cell: { ownShare: 1, mixVersion: 2 }, recipient: { contactId: 'c1' } }),
			decideMixAssignment({ cell: { ownShare: 0.4, mixVersion: 2 }, recipient: {} }),
		]) {
			expect(decision.bucket).toBeNull();
		}
	});

	it('routes the strategy module to the arm the decision names', () => {
		const entries = [
			{ providerType: 'mta' as const, isEnabled: true },
			{ providerType: 'ses' as const, isEnabled: true },
		];
		let own = 0;
		for (const contactId of AUDIENCE.slice(0, 4000)) {
			const route = adaptiveMixStrategy.select(entries, undefined, undefined, {
				kind: 'decide',
				input: {
					cell: { ownShare: 0.25, mixVersion: 2 },
					recipient: { contactId, campaignId: 'cmp-1' },
				},
			});
			expect(route).not.toBeNull();
			if (route?.providerType === 'mta') own += 1;
		}
		expect(Math.abs(own / 4000 - 0.25)).toBeLessThan(0.025);
	});

	it('is registered as a deterministic peer strategy', () => {
		expect(adaptiveMixStrategy.kind).toBe('adaptive_mix');
		expect(adaptiveMixStrategy.isDeterministic).toBe(true);
	});
});

/**
 * THE MULTI-CELL MATRIX — the case a single-cell matrix cannot see.
 *
 * Every assertion above ranks ONE homogeneous audience against ONE share, so a
 * ranking cohort taken over the whole batch and a stratified cut taken against
 * a cell's share look identical. They are not. Rank is a percentile, and the
 * cut `rank >= 1 - s` only realises `s` inside a cell if that cell's ranks are
 * uniform over [0,1). As soon as engagement correlates with who runs the
 * mailbox — consumer gmail vs corporate microsoft vs a legacy tail, an entirely
 * ordinary correlation — a batch-wide cohort hands the high-scoring cell ranks
 * clustered near 1 and the low-scoring cells ranks clustered near 0: the first
 * cell overshoots its set point badly and the others get nothing.
 *
 * So this runs the real path end to end — `recordSendAssignments`, the shipped
 * MX-learned classifier, the real `buildEngagementRanker`, the real cell seam —
 * over three cells with DISJOINT score bands and three DIFFERENT shares, and
 * requires each cell's realised own share to track ITS OWN configured share.
 */
describe('adaptive_mix — multi-cell split matrix (skewed cells)', () => {
	const ORG = 'org-multicell';
	// Disjoint bands, deliberately ordered so a batch-wide cohort would put
	// gmail entirely above microsoft entirely above other.
	const CELLS = [
		{ provider: 'gmail' as const, domain: 'gmail.com', count: 400, low: 40, high: 100, share: 0.5 },
		{
			provider: 'microsoft' as const,
			domain: 'outlook.com',
			count: 250,
			low: 10,
			high: 50,
			share: 0.25,
		},
		{
			provider: 'other' as const,
			domain: 'legacy.example',
			count: 150,
			low: 0,
			high: 20,
			share: 0.8,
		},
	];

	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		for (const kind of ['mta', 'ses'] as const) {
			for (const name of sendProviderCatalogEntry(kind).requiredEnvVars) {
				vi.stubEnv(
					name,
					name === 'MTA_API_URL' ? 'https://mta.test' : `test-${name.toLowerCase()}`
				);
			}
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('realises each cell’s own share against that cell’s configured share', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'adaptive_mix',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
				],
				createdAt: now,
				updatedAt: now,
			});
			for (const cell of CELLS) {
				await ctx.db.insert('deliverabilityRouteStates', {
					organizationId: ORG,
					destinationProvider: cell.provider,
					stream: 'campaign',
					isFallbackActive: false,
					ownShare: cell.share,
					mixVersion: 7,
					signals: [],
					snapshotGeneratedAt: now,
					expiresAt: now + 600_000,
					updatedAt: now,
				});
			}
		});

		const recipients: Array<{
			sendId: string;
			email: string;
			contactId: string;
			engagementScore: number;
		}> = [];
		for (const cell of CELLS) {
			for (let index = 0; index < cell.count; index += 1) {
				// Distinct scores inside the band, so the cell's own cohort ranks
				// cleanly and the assertion is about the CUT, not about ties.
				const score = cell.low + ((cell.high - cell.low) * index) / cell.count;
				recipients.push({
					sendId: `send-${cell.provider}-${index}`,
					email: `user${index}@${cell.domain}`,
					contactId: `ct-${cell.provider}-${String(index).padStart(6, '0')}`,
					engagementScore: score,
				});
			}
		}

		await t.run(async (ctx) => {
			await recordSendAssignments(ctx, {
				organizationId: ORG,
				stream: 'campaign',
				sendKind: 'campaign',
				campaignId: 'cmp-multicell',
				routing: { messageType: 'campaign', from: 'news@example.com' },
				recipients,
			});
		});

		const rows = await t.run(async (ctx) => await ctx.db.query('sendAssignments').collect());
		expect(rows.length).toBe(recipients.length);
		const scoreBySendId = new Map(
			recipients.map((recipient) => [recipient.sendId, recipient.engagementScore])
		);

		for (const cell of CELLS) {
			const cellRows = rows.filter((row) => row.cell === `campaign:${cell.provider}`);
			expect(cellRows.length).toBe(cell.count);
			const ownRows = cellRows.filter((row) => row.arm === 'own');
			const realised = ownRows.length / cellRows.length;
			// 6pp: the cut is deterministic in rank, so the only slack is the
			// cohort's granularity plus the calibration slice's random draw.
			expect(Math.abs(realised - cell.share)).toBeLessThan(0.06);

			// The stratified branch really is the one under test — if ranking
			// stopped engaging, every cell would fall back to the hash bucket
			// (which realises `s` exactly) and the assertion above would pass
			// vacuously. Under stratification the own arm is the cell's MOST
			// ENGAGED tail, so its mean score sits above the reference arm's.
			const meanScore = (subset: typeof cellRows) =>
				subset.reduce((sum, row) => sum + (scoreBySendId.get(row.sendId) ?? 0), 0) /
				Math.max(subset.length, 1);
			const referenceRows = cellRows.filter((row) => row.arm === 'reference');
			expect(meanScore(ownRows)).toBeGreaterThan(meanScore(referenceRows));
		}
	});
});

/**
 * MANDRILL AS THE REFERENCE ARM (P1.3, plan D8).
 *
 * The migration this plan exists for is `adaptive_mix` over `[mta, mandrill]`:
 * the cell starts at `ownShare = 0` (everything still leaving through the
 * account the team arrived with) and the controller walks it to 1. Nothing in
 * the strategy or in the assignment writer knows the word "mandrill" — the arm
 * is decided by ONE constant, {@link OWN_ARM_TRANSPORT_KIND}, and everything
 * that is not it is the reference arm. So this asserts the two facts that
 * constant is load-bearing for, against a Mandrill route:
 *
 *   - the own arm stays the owned MTA — a plan that quietly made the newest
 *     transport "own" would invert every ramp gate's reading of which side is
 *     being measured, and no arithmetic in the controller would notice;
 *   - a recipient assigned to the reference arm both DISPATCHES on Mandrill and
 *     is RECORDED as `arm: 'reference'`, through the real writer.
 */
describe('adaptive_mix — Mandrill is the reference arm', () => {
	const ORG = 'org-mandrill-arm';
	const ENTRIES = [
		{ providerType: 'mta' as const, isEnabled: true },
		{ providerType: 'mandrill' as const, isEnabled: true },
	];

	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		for (const kind of ['mta', 'mandrill'] as const) {
			for (const name of sendProviderCatalogEntry(kind).requiredEnvVars) {
				vi.stubEnv(
					name,
					name === 'MTA_API_URL' ? 'https://mta.test' : `test-${name.toLowerCase()}`
				);
			}
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('keeps the OWN arm the owned MTA and grades Mandrill as reference', () => {
		expect(OWN_ARM_TRANSPORT_KIND).toBe('mta');
		expect(armForTransport('mandrill')).toBe('reference');
		expect(armForTransport('mta')).toBe('own');
	});

	it('sends the reference share to Mandrill and the own share to the MTA', () => {
		let mandrill = 0;
		for (const contactId of AUDIENCE.slice(0, 4000)) {
			const decision = decideMixAssignment({
				cell: { ownShare: 0.3, mixVersion: 5 },
				recipient: { contactId, campaignId: 'cmp-migrate' },
			});
			const route = adaptiveMixStrategy.select(ENTRIES, undefined, undefined, {
				kind: 'decide',
				input: {
					cell: { ownShare: 0.3, mixVersion: 5 },
					recipient: { contactId, campaignId: 'cmp-migrate' },
				},
			});
			// The transport the strategy picks is a pure function of the arm the
			// decision named — asserted per recipient, not just in aggregate, so a
			// transport chosen independently of the decision could not pass.
			expect(route?.providerType).toBe(decision.arm === 'own' ? 'mta' : 'mandrill');
			if (route?.providerType === 'mandrill') mandrill += 1;
		}
		expect(Math.abs(mandrill / 4000 - 0.7)).toBeLessThan(0.025);
	});

	it('is deterministic per recipient with Mandrill in the mix', () => {
		// The same property `adaptiveMixDeterminism` pins on the decision, asserted
		// on the TRANSPORT: a recipient that moved between the two arms across the
		// pages of one campaign would land in both denominators.
		for (const contactId of AUDIENCE.slice(0, 300)) {
			const first = adaptiveMixStrategy.select(ENTRIES, undefined, undefined, {
				kind: 'decide',
				input: {
					cell: { ownShare: 0.45, mixVersion: 2 },
					recipient: { contactId, campaignId: 'cmp-migrate' },
				},
			});
			for (let repeat = 0; repeat < 3; repeat += 1) {
				expect(
					adaptiveMixStrategy.select(ENTRIES, undefined, undefined, {
						kind: 'decide',
						input: {
							cell: { ownShare: 0.45, mixVersion: 2 },
							recipient: { contactId, campaignId: 'cmp-migrate' },
						},
					})
				).toEqual(first);
			}
		}
	});

	it('records `transport: mandrill` as `arm: reference` through the real writer', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'adaptive_mix',
				providers: ENTRIES.map((entry) => ({ ...entry })),
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail',
				stream: 'campaign',
				isFallbackActive: false,
				ownShare: 0.5,
				mixVersion: 9,
				signals: [],
				snapshotGeneratedAt: now,
				expiresAt: now + 600_000,
				updatedAt: now,
			});
		});

		const recipients = syntheticContactIds(400, 'md').map((contactId, index) => ({
			sendId: `send-md-${index}`,
			email: `user${index}@gmail.com`,
			contactId,
		}));
		await t.run(async (ctx) => {
			await recordSendAssignments(ctx, {
				organizationId: ORG,
				stream: 'campaign',
				sendKind: 'campaign',
				campaignId: 'cmp-migrate',
				routing: { messageType: 'campaign', from: 'news@example.com' },
				recipients,
			});
		});

		const rows = await t.run(async (ctx) => await ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(recipients.length);
		const transports = new Set(rows.map((row) => row.transport));
		// Both arms are populated, or the per-row assertion below is vacuous.
		expect([...transports].sort()).toEqual(['mandrill', 'mta']);
		for (const row of rows) {
			expect(row.arm).toBe(row.transport === 'mandrill' ? 'reference' : 'own');
			expect(row.cell).toBe('campaign:gmail');
		}
	});
});
