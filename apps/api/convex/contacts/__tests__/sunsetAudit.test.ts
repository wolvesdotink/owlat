import { describe, it, expect } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import { SUNSET_POLICY_DEFAULTS } from '../sunsetPolicy';
import {
	evaluateAndApplySunset,
	restoreSunsetSuppression,
	setSunsetExemption,
} from '../sunsetEngine';
import { NOW, daysAgo, harness, type Harness } from './sunsetFixtures';

/**
 * EVERY AUTOMATIC TRANSITION IS AUDITED, and the restore path works and is
 * itself audited (deliverability plan P4-4). "The engine did it" is a
 * first-class answer to "who": the entry carries `userId: 'system'` and an
 * explicit `actor: 'sunset_engine'` detail alongside the decision's reason.
 */

async function seedContact(
	t: Harness,
	args: {
		email: string;
		tenureDays: number;
		firstSendDaysAgo: number;
		lastEngagementDaysAgo?: number;
	}
): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert(
			'contacts',
			createTestContact({
				email: args.email,
				createdAt: daysAgo(args.tenureDays),
				updatedAt: daysAgo(args.tenureDays),
			})
		);
		await ctx.db.insert('contactActivities', {
			contactId: id,
			activityType: 'email_sent',
			occurredAt: daysAgo(args.firstSendDaysAgo),
		});
		if (args.lastEngagementDaysAgo !== undefined) {
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_opened',
				occurredAt: daysAgo(args.lastEngagementDaysAgo),
			});
		}
		return id;
	});
}

async function sweepOne(t: Harness, contactId: Id<'contacts'>) {
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

async function auditEntries(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
}

describe('sunset audit trail', () => {
	it('audits the move onto the re-engagement track with a reason and the engine as actor', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'quiet@example.com',
			tenureDays: 400,
			firstSendDaysAgo: 390,
			lastEngagementDaysAgo: 200,
		});

		const applied = await sweepOne(t, contactId);
		expect(applied.verdict.action).toBe('enter_reengagement');

		const logs = await auditEntries(t);
		expect(logs).toHaveLength(1);
		const entry = logs[0];
		expect(entry?.action).toBe('contact.sunset_reengagement');
		expect(entry?.resource).toBe('contact');
		expect(entry?.resourceId).toBe(contactId);
		expect(entry?.userId).toBe('system');
		expect(entry?.details?.['actor']).toBe('sunset_engine');
		expect(entry?.details?.['reason']).toBe('quiet_past_reengage_window');
		expect(entry?.details?.['fromStage']).toBe('engaged');
		expect(entry?.details?.['toStage']).toBe('reengagement');
	});

	it('audits the suppression and stores the full decision snapshot', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'gone@example.com',
			tenureDays: 500,
			firstSendDaysAgo: 480,
		});

		const applied = await sweepOne(t, contactId);
		expect(applied.verdict.action).toBe('suppress');

		const logs = await auditEntries(t);
		const entry = logs.find((log) => log.action === 'contact.sunset_suppressed');
		expect(entry).toBeDefined();
		expect(entry?.userId).toBe('system');
		expect(entry?.details?.['reason']).toBe('quiet_past_suppress_window');
		expect(typeof entry?.detailsBlob).toBe('string');
		const snapshot = JSON.parse(entry?.detailsBlob ?? '{}') as {
			facts?: { hasSendHistory?: boolean };
			policy?: { suppressAfterDays?: number };
			verdict?: { reason?: string };
		};
		expect(snapshot.facts?.hasSendHistory).toBe(true);
		expect(snapshot.policy?.suppressAfterDays).toBe(270);
		expect(snapshot.verdict?.reason).toBe('quiet_past_suppress_window');
	});

	it('audits the resume back onto the normal track', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'back@example.com',
			tenureDays: 400,
			firstSendDaysAgo: 390,
			lastEngagementDaysAgo: 5,
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(contactId, { sunsetStage: 'reengagement', sunsetStageAt: daysAgo(30) });
		});

		const applied = await sweepOne(t, contactId);
		expect(applied.verdict.action).toBe('resume');

		const logs = await auditEntries(t);
		expect(logs.some((log) => log.action === 'contact.sunset_resumed')).toBe(true);
	});

	it('writes no audit entry for a hold', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'active@example.com',
			tenureDays: 400,
			firstSendDaysAgo: 390,
			lastEngagementDaysAgo: 5,
		});

		const applied = await sweepOne(t, contactId);
		expect(applied.applied).toBe(false);
		expect(await auditEntries(t)).toHaveLength(0);
	});
});

describe('sunset restore path', () => {
	it('restores a suppressed contact in one action, audited, with the override set', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'restore-me@example.com',
			tenureDays: 500,
			firstSendDaysAgo: 480,
		});
		expect((await sweepOne(t, contactId)).verdict.action).toBe('suppress');

		const result = await t.run(
			async (ctx) =>
				await restoreSunsetSuppression(ctx, {
					contactId,
					actorUserId: 'user_operator_1',
					now: NOW,
				})
		);
		expect(result).toEqual({ restored: true, removedSuppression: true, reason: 'restored' });

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact?.sunsetStage).toBe('engaged');
			expect(contact?.sunsetExemptAt).toBe(NOW);
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
		});

		const logs = await auditEntries(t);
		const restored = logs.find((log) => log.action === 'contact.sunset_restored');
		expect(restored?.userId).toBe('user_operator_1');
		expect(restored?.details?.['removedSuppression']).toBe(true);
		expect(restored?.details?.['exempted']).toBe(true);
	});

	it('a restored contact is not re-suppressed by the next evaluation', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'stays-restored@example.com',
			tenureDays: 500,
			firstSendDaysAgo: 480,
		});
		await sweepOne(t, contactId);
		await t.run(
			async (ctx) =>
				await restoreSunsetSuppression(ctx, {
					contactId,
					actorUserId: 'user_operator_1',
					now: NOW,
				})
		);

		const second = await sweepOne(t, contactId);
		expect(second.applied).toBe(false);
		expect(second.verdict.reason).toBe('operator_override');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
		});
	});

	it('refuses to remove a bounce suppression it did not create', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'bounced@example.com',
			tenureDays: 500,
			firstSendDaysAgo: 480,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'bounced@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				createdAt: daysAgo(100),
			});
		});

		const result = await t.run(
			async (ctx) =>
				await restoreSunsetSuppression(ctx, {
					contactId,
					actorUserId: 'user_operator_1',
					now: NOW,
				})
		);
		expect(result.restored).toBe(false);
		expect(result.outcome).toBe('not_sunset_suppressed');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(1);
		});
	});
});

describe('sunset operator exemption', () => {
	it('is audited in both directions and blocks the engine while set', async () => {
		const t = harness();
		const contactId = await seedContact(t, {
			email: 'exempt@example.com',
			tenureDays: 500,
			firstSendDaysAgo: 480,
		});

		await t.run(
			async (ctx) =>
				await setSunsetExemption(ctx, {
					contactId,
					exempt: true,
					actorUserId: 'user_operator_1',
					now: NOW,
				})
		);
		expect((await sweepOne(t, contactId)).verdict.reason).toBe('operator_override');

		await t.run(
			async (ctx) =>
				await setSunsetExemption(ctx, {
					contactId,
					exempt: false,
					actorUserId: 'user_operator_1',
					now: NOW,
				})
		);
		expect((await sweepOne(t, contactId)).verdict.action).toBe('suppress');

		const logs = await auditEntries(t);
		expect(logs.filter((log) => log.action === 'contact.sunset_exemption_changed')).toHaveLength(2);
	});
});
