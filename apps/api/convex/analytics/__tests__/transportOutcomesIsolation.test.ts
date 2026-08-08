/**
 * transportOutcomes — tenant isolation.
 *
 * `transportOutcomes` is cell-keyed aggregate sending history. A cell-keyed
 * table readable across tenants is a security defect, which is why the bucket
 * index is org-leading (the deliberate addition to the plan's sketch, matching
 * `sendAssignments`). This file pins that: neither the reader nor the
 * assignment join may cross an organization boundary.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import {
	recordTransportOutcomeForCell,
	recordTransportOutcomeForSend,
	summarizeTransportOutcomeArms,
	summarizeTransportOutcomes,
} from '../transportOutcomes';
import { startOfDayUtc } from '../../lib/clock';
import { modules } from '../../__tests__/testModules';
import {
	bucketRow,
	GMAIL_CAMPAIGN_CELL,
	OTHER_ORG,
	OUTCOME_ORG,
	readBuckets,
	seedAssignedSend,
} from './transportOutcomesFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

describe('tenant isolation', () => {
	it('never sums the buckets of another organization into a cell summary', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: day, shardKey: 0, sent: 10, delivered: 9 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({
					organizationId: OTHER_ORG,
					periodStart: day,
					shardKey: 0,
					sent: 1000,
					delivered: 100,
				})
			);
		});

		await t.run(async (ctx) => {
			const mine = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			});
			expect(mine.sent).toBe(10);
			expect(mine.deliveryRate).toBeCloseTo(0.9, 10);

			const theirs = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OTHER_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			});
			expect(theirs.sent).toBe(1000);
			expect(theirs.deliveryRate).toBeCloseTo(0.1, 10);
		});
	});

	it('the arm pair is org-scoped too', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ organizationId: OTHER_ORG, periodStart: day, shardKey: 2, sent: 500 })
			);
		});

		const summary = await t.run(
			async (ctx) =>
				await summarizeTransportOutcomeArms(ctx.db, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
				})
		);
		expect(summary.own.sent).toBe(0);
		expect(summary.reference.sent).toBe(0);
	});

	it('writes land under the organization they were recorded for', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await recordTransportOutcomeForCell(ctx, {
				organizationId: OTHER_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
				event: 'sent',
				isCalibration: false,
			});
			expect(await readBuckets(ctx, { organizationId: OUTCOME_ORG })).toHaveLength(0);
			expect(await readBuckets(ctx, { organizationId: OTHER_ORG })).toHaveLength(1);
		});
	});

	it('does not join a send to the assignment row of another organization', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			// The assignment exists — but under a DIFFERENT org than the one the
			// recorder resolves. An org-blind join would happily record an outcome
			// into another tenant's cell.
			const seeded = await seedAssignedSend(ctx, {
				status: 'sent',
				assignment: { organizationId: OTHER_ORG },
			});
			expect(
				await recordTransportOutcomeForSend(ctx, { sendId: seeded.sendId, event: 'delivered' })
			).toBe('no_assignment');
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});
});
