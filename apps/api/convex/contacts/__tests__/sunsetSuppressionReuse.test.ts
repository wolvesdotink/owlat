import { describe, it, expect } from 'vitest';
import { applyEffects } from '../../delivery/sendLifecycle/effects';
import schema from '../../schema';
import { createTestContact } from '../../__tests__/factories';
import { isSuppressed, loadSuppressionSet, suppressEmail } from '../../lib/suppression';
import {
	MARKETING_ONLY_BLOCK_REASONS,
	isMarketingOnlyBlockReason,
	toMtaSuppressionReason,
} from '../../delivery/suppressionMirror';
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

	it('does NOT push the hygiene suppression onto the MTA last-hop list', async () => {
		const t = harness();
		await suppressOne(t, 'mirrored@example.com');

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		// The MTA list sits UNDER Convex and blocks everything that reaches it,
		// transactional mail included — so the one reason Convex deliberately
		// scopes to marketing must never be mirrored there.
		expect(scheduled.filter((job) => job.name.includes('suppressionMirror'))).toEqual([]);
	});

	it('still mirrors the reasons that ARE evidence about the mailbox', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await suppressEmail(ctx, { email: 'Bounced@Example.com', reason: 'bounced', now: NOW });
		});

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		const mirror = scheduled.find((job) => job.name.includes('suppressionMirror'));
		expect(mirror).toBeDefined();
		expect(mirror?.args[0]).toMatchObject({ email: 'bounced@example.com', reason: 'bounced' });
	});

	it('keeps the shipped MTA reason mapping intact for the mirrored reasons', () => {
		expect(toMtaSuppressionReason('bounced')).toBe('hard_bounce');
		expect(toMtaSuppressionReason('bounced', 'soft')).toBe('manual');
		expect(toMtaSuppressionReason('complained')).toBe('complaint');
		expect(toMtaSuppressionReason('manual')).toBe('manual');
	});

	it('classifies exactly one reason as marketing-only', () => {
		expect([...MARKETING_ONLY_BLOCK_REASONS]).toEqual(['unengaged']);
		expect(isMarketingOnlyBlockReason('unengaged')).toBe(true);
		for (const reason of ['bounced', 'complained', 'manual'] as const) {
			expect(isMarketingOnlyBlockReason(reason)).toBe(false);
		}
	});

	it('blocks bulk mail but NOT the transactional / double-opt-in path', async () => {
		const t = harness();
		await suppressOne(t, 'quiet-customer@example.com');

		await t.run(async (ctx) => {
			// The campaign / enqueue gate — the strict default scope.
			expect(await isSuppressed(ctx, 'quiet-customer@example.com')).toBe(true);
			expect((await loadSuppressionSet(ctx)).has('quiet-customer@example.com')).toBe(true);
			// The transactional intake and the DOI confirmation it sends. A customer
			// who ignores the newsletter has not asked to stop receiving receipts.
			expect(
				await isSuppressed(ctx, 'quiet-customer@example.com', { scope: 'transactional' })
			).toBe(false);
		});
	});

	it('still blocks the transactional path on bounce and complaint evidence', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await suppressEmail(ctx, { email: 'broken@example.com', reason: 'bounced', now: NOW });
			await suppressEmail(ctx, { email: 'angry@example.com', reason: 'complained', now: NOW });
			await suppressEmail(ctx, { email: 'blocked@example.com', reason: 'manual', now: NOW });
		});

		await t.run(async (ctx) => {
			for (const email of ['broken@example.com', 'angry@example.com', 'blocked@example.com']) {
				expect(await isSuppressed(ctx, email, { scope: 'transactional' })).toBe(true);
			}
		});
	});

	it('rejects the auto-suppressed address at the transactional intake only for bulk', async () => {
		const t = harness();
		await suppressOne(t, 'receipts@example.com');

		// The shipped transactional dispatcher's own gate, exercised through the
		// same helper it calls, at the scope it now passes.
		const rejectedAtIntake = await t.run(
			async (ctx) => await isSuppressed(ctx, 'receipts@example.com', { scope: 'transactional' })
		);
		expect(rejectedAtIntake).toBe(false);
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

	/**
	 * THE HYGIENE ROW IS THE WEAKEST EVIDENCE CLASS THERE IS, and it must yield
	 * to evidence about the MAILBOX.
	 *
	 * The address is still transactionally sendable by design, so it can still
	 * hard-bounce or draw a complaint afterwards. If the shipped
	 * `blocklist_insert` path treated the existing `unengaged` row as "already
	 * suppressed, nothing to do", that evidence would be silently discarded: the
	 * address would stay on the permissive scope forever, keep bouncing against a
	 * young IP, never reach the MTA backstop, and read as "Unengaged" rather than
	 * "Bounced" on the operator's suppression screen.
	 */
	describe('an engine-written row absorbs later mailbox-level evidence', () => {
		async function transactionalSendId(t: ReturnType<typeof harness>) {
			return await t.run(
				async (ctx) =>
					await ctx.db.insert('transactionalSends', {
						kind: 'transactional' as const,
						email: 'quiet-then-broken@example.com',
						status: 'queued' as const,
						providerType: 'mta',
					})
			);
		}

		it('upgrades an unengaged row to bounced, blocks every scope, and mirrors it', async () => {
			const t = harness();
			await suppressOne(t, 'quiet-then-broken@example.com');
			const sendId = await transactionalSendId(t);

			await t.run(async (ctx) => {
				await applyEffects(ctx, [
					{
						kind: 'blocklist_insert',
						email: 'quiet-then-broken@example.com',
						reason: 'bounced',
						bounceType: 'hard',
						source: { kind: 'transactional', id: sendId },
					},
				]);
			});

			await t.run(async (ctx) => {
				// ONE row, upgraded in place — not a second parallel suppression.
				const rows = await ctx.db.query('blockedEmails').collect();
				expect(rows).toHaveLength(1);
				expect(rows[0]?.reason).toBe('bounced');
				expect(rows[0]?.bounceType).toBe('hard');
				expect(rows[0]?.sourceTransactionalSendId).toBe(sendId);
				// The permissive scope now blocks: this is evidence about the mailbox.
				expect(
					await isSuppressed(ctx, 'quiet-then-broken@example.com', { scope: 'transactional' })
				).toBe(true);
			});

			const scheduled = await t.run(
				async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
			);
			const mirror = scheduled.find((job) => job.name.includes('suppressionMirror'));
			expect(mirror).toBeDefined();
			expect(mirror?.args[0]).toMatchObject({
				email: 'quiet-then-broken@example.com',
				reason: 'bounced',
				bounceType: 'hard',
			});
		});

		it('upgrades an unengaged row to complained too', async () => {
			const t = harness();
			await suppressOne(t, 'quiet-then-broken@example.com');
			const sendId = await transactionalSendId(t);

			await t.run(async (ctx) => {
				await applyEffects(ctx, [
					{
						kind: 'blocklist_insert',
						email: 'quiet-then-broken@example.com',
						reason: 'complained',
						source: { kind: 'transactional', id: sendId },
					},
				]);
			});

			await t.run(async (ctx) => {
				const rows = await ctx.db.query('blockedEmails').collect();
				expect(rows).toHaveLength(1);
				expect(rows[0]?.reason).toBe('complained');
				expect(rows[0]?.bounceType).toBeUndefined();
				expect(
					await isSuppressed(ctx, 'quiet-then-broken@example.com', { scope: 'transactional' })
				).toBe(true);
			});

			const scheduled = await t.run(
				async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
			);
			expect(
				scheduled.find((job) => job.name.includes('suppressionMirror'))?.args[0]
			).toMatchObject({ reason: 'complained' });
		});

		it('does not downgrade a hard bounce back to a soft one', async () => {
			const t = harness();
			const sendId = await transactionalSendId(t);
			await t.run(async (ctx) => {
				await ctx.db.insert('blockedEmails', {
					email: 'quiet-then-broken@example.com',
					reason: 'bounced',
					bounceType: 'hard',
					createdAt: daysAgo(10),
				});
				await applyEffects(ctx, [
					{
						kind: 'blocklist_insert',
						email: 'quiet-then-broken@example.com',
						reason: 'bounced',
						bounceType: 'soft',
						source: { kind: 'transactional', id: sendId },
					},
				]);
			});

			await t.run(async (ctx) => {
				const rows = await ctx.db.query('blockedEmails').collect();
				expect(rows).toHaveLength(1);
				expect(rows[0]?.bounceType).toBe('hard');
			});
		});
	});

	it('introduces no parallel suppression table', () => {
		const tableNames = Object.keys(schema.tables);
		expect(tableNames).toContain('blockedEmails');
		expect(tableNames.filter((name) => /suppress/i.test(name))).toEqual([]);
	});
});
