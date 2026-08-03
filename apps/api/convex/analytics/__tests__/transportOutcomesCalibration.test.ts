/**
 * transportOutcomes — the calibration slice (plan D8).
 *
 * Stratified assignment (top engagement percentile first) maximises warming
 * quality and DESTROYS the causal comparison, so a small purely-random
 * calibration slice is carved out and is the ONLY input to the engagement-ratio
 * gate. That only works if the calibration counters are tracked separately and
 * are never silently folded into the general rates — a summarizer that mixes
 * them feeds the gate a stratified number, which is the defect this file exists
 * to prevent.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { recordTransportOutcomeForCell, summarizeTransportOutcomes } from '../transportOutcomes';
import { modules } from '../../__tests__/testModules';
import {
	GMAIL_CAMPAIGN_CELL,
	OUTCOME_ORG,
	readBuckets,
	seedAssignedSend,
	sumCounter,
	drainOutcomeWrites,
} from './transportOutcomesFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

describe('calibration counters', () => {
	it('a calibration-assigned send bumps BOTH the general counter and its twin', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, {
				status: 'queued',
				assignment: { isCalibration: true },
			});
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'sent', at: Date.now(), providerMessageId: 'pm-cal', providerType: 'mta' },
		});
		await drainOutcomeWrites(t);

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			// The slice is part of the send, so removing it from the general
			// denominator would make the cell's rates disagree with reality. The
			// twin is an ADDITIONAL, narrower counter — not a partition.
			expect(sumCounter(buckets, 'sent')).toBe(1);
			expect(sumCounter(buckets, 'calibrationSent')).toBe(1);
		});
	});

	it('a non-calibration send never touches a calibration counter', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (const event of ['sent', 'opened', 'clicked'] as const) {
				await recordTransportOutcomeForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					event,
					isCalibration: false,
				});
			}
			const buckets = await readBuckets(ctx);
			expect(sumCounter(buckets, 'calibrationSent')).toBe(0);
			expect(sumCounter(buckets, 'calibrationOpened')).toBe(0);
			expect(sumCounter(buckets, 'calibrationClicked')).toBe(0);
		});
	});

	it('derives the calibration rates from the SLICE only, and the general rates from everything', async () => {
		const t = convexTest(schema, modules);
		// 900 stratified sends opening at 50%; 100 calibration sends opening at 10%.
		// A summarizer that folded the slice in would report one blended number and
		// the engagement-ratio gate would never see the honest signal.
		await t.run(async (ctx) => {
			const bump = async (event: 'sent' | 'delivered' | 'opened', isCalibration: boolean) =>
				await recordTransportOutcomeForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					event,
					isCalibration,
				});
			for (let i = 0; i < 90; i += 1) {
				await bump('sent', false);
				await bump('delivered', false);
				if (i < 45) await bump('opened', false);
			}
			for (let i = 0; i < 10; i += 1) {
				await bump('sent', true);
				await bump('delivered', true);
				if (i < 1) await bump('opened', true);
			}
		});

		await t.run(async (ctx) => {
			const summary = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			});
			expect(summary.sent).toBe(100);
			expect(summary.delivered).toBe(100);
			expect(summary.opened).toBe(46);
			expect(summary.openRate).toBeCloseTo(0.46, 10);

			expect(summary.calibrationSent).toBe(10);
			expect(summary.calibrationOpened).toBe(1);
			expect(summary.calibrationOpenRate).toBeCloseTo(0.1, 10);
			// The two are different numbers derived from different denominators —
			// that difference IS the point of the slice.
			expect(summary.calibrationOpenRate).not.toBeCloseTo(summary.openRate, 3);
		});
	});

	it('guards a zero calibration denominator (a cell past graduation carries no slice)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await recordTransportOutcomeForCell(ctx, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				event: 'opened',
				isCalibration: false,
			});
			const summary = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			});
			expect(summary.calibrationOpenRate).toBe(0);
			expect(summary.calibrationClickRate).toBe(0);
		});
	});
});
