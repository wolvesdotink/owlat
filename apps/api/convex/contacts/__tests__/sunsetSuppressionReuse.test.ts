import { describe, it, expect } from 'vitest';
import { createTestContact } from '../../__tests__/factories';
import { isSuppressed, loadSuppressionSet } from '../../lib/suppression';
import { toMtaSuppressionReason } from '../../delivery/suppressionMirror';
import { SUNSET_POLICY_DEFAULTS } from '../sunsetPolicy';
import { evaluateAndApplySunset } from '../sunsetEngine';
import { NOW, daysAgo, harness } from './sunsetFixtures';

/**
 * REGRESSION: the sunset engine REUSES the shipped suppression path — it does
 * not introduce a parallel suppression concept (deliverability plan P4-4).
 *
 * The evidence is behavioural, not structural: an auto-suppressed address ends
 * up on the same `blockedEmails` table, is seen by the same `lib/suppression.ts`
 * lookups that gate the transactional intake, the non-campaign enqueue writer
 * and audience resolution, and is mirrored to the MTA backstop by the same
 * scheduled action every other suppression uses.
 */

function harness() {
	return convexTest(schema, modules);
}

async function suppressOne(t: ReturnType<typeof harness>, email: string) {
	const contactId = await t.run(async (ctx) => {
		const id = await ctx.db.insert(
			'contacts',
			createTestContact({ email, createdAt: daysAgo(500), updatedAt: daysAgo(500) })
		);
		await ctx.db.insert('contactActivities', {
			contactId: id,
			activityType: 'email_sent',
			occurredAt: daysAgo(480),
		});
		return id;
	});

	return await t.run(async (ctx) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) throw new Error('fixture contact missing');
		return await evaluateAndApplySunset(ctx, {
			contact,
			policy: { ...SUNSET_POLICY_DEFAULTS },
			now: NOW,
		});
	});
}

describe('sunset suppression reuses the shipped path', () => {
	it('writes to blockedEmails, the shipped suppression table', async () => {
		const t = harness();
		const applied = await suppressOne(t, 'Reuse@Example.com');
		expect(applied.verdict.action).toBe('suppress');

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('blockedEmails').collect();
			expect(rows).toHaveLength(1);
			// Normalized by the shipped helper, not by a second normalizer.
			expect(rows[0]?.email).toBe('reuse@example.com');
			expect(rows[0]?.reason).toBe('unengaged');
			expect(typeof rows[0]?.notes).toBe('string');
		});
	});

	it('is honoured by the shipped point-read gate', async () => {
		const t = harness();
		await suppressOne(t, 'gated@example.com');

		await t.run(async (ctx) => {
			expect(await isSuppressed(ctx, 'gated@example.com')).toBe(true);
			// Same address, different casing/whitespace — the shipped normalizer.
			expect(await isSuppressed(ctx, '  GATED@example.com ')).toBe(true);
			expect(await isSuppressed(ctx, 'someone-else@example.com')).toBe(false);
		});
	});

	it('is honoured by the shipped bulk gate used for audience resolution', async () => {
		const t = harness();
		await suppressOne(t, 'bulk@example.com');

		await t.run(async (ctx) => {
			const set = await loadSuppressionSet(ctx);
			expect(set.has('bulk@example.com')).toBe(true);
		});
	});

	it('mirrors to the MTA backstop through the shipped scheduled action', async () => {
		const t = harness();
		await suppressOne(t, 'mirrored@example.com');

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		const mirror = scheduled.find((job) => job.name.includes('suppressionMirror'));
		expect(mirror).toBeDefined();
		expect(mirror?.args[0]).toMatchObject({ email: 'mirrored@example.com', reason: 'unengaged' });
	});

	it('maps the sunset reason onto the MTA vocabulary without faking a hard bounce', () => {
		// A hygiene suppression must NOT masquerade as permanent bounce evidence
		// in the MTA list — it rides the expiring `manual` reason instead.
		expect(toMtaSuppressionReason('unengaged')).toBe('manual');
		expect(toMtaSuppressionReason('bounced')).toBe('hard_bounce');
		expect(toMtaSuppressionReason('complained')).toBe('complaint');
	});

	it('never downgrades an existing bounce suppression', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'already@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(480),
			});
			await ctx.db.insert('blockedEmails', {
				email: 'already@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				createdAt: daysAgo(100),
			});
			return id;
		});

		const applied = await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			if (!contact) throw new Error('fixture contact missing');
			return await evaluateAndApplySunset(ctx, {
				contact,
				policy: { ...SUNSET_POLICY_DEFAULTS },
				now: NOW,
			});
		});

		expect(applied.applied).toBe(false);
		expect(applied.verdict.reason).toBe('already_suppressed');

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('blockedEmails').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.reason).toBe('bounced');
			expect(rows[0]?.bounceType).toBe('hard');
		});
	});

	it('introduces no parallel suppression table', () => {
		const tableNames = Object.keys(schema.tables);
		expect(tableNames).toContain('blockedEmails');
		expect(tableNames.filter((name) => /suppress/i.test(name))).toEqual([]);
	});
});
