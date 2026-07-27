import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { createTestContact } from '../../__tests__/factories';
import { evaluateSunset, SUNSET_POLICY_DEFAULTS } from '../sunsetPolicy';
import { evaluateAndApplySunset } from '../sunsetEngine';
import { DAY, NOW, daysAgo, facts, policy } from './sunsetFixtures';

/**
 * THE BLOCKING SAFETY SUITE (deliverability plan P4-4).
 *
 * Auto-suppression is the most destructive thing in the plan, so the properties
 * below are not "nice to have": each one asserts that a whole class of bad or
 * missing input makes every suppressing path UNREACHABLE. If one of these fails,
 * the feature is not shippable.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const contactsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../contacts/'),
		mod,
	])
);
const modules = { ...rootGlob, ...contactsGlob };

describe('sunset safety — an empty activity history is never evidence of disengagement', () => {
	it('holds a contact we have never sent to, however old the row is', () => {
		const v = evaluateSunset(
			facts({ createdAt: daysAgo(3650), hasSendHistory: false, firstMessagedAt: undefined }),
			policy()
		);
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('no_send_history');
	});

	it('holds when the send-history flag is set but the instant is missing', () => {
		const v = evaluateSunset(facts({ hasSendHistory: true, firstMessagedAt: undefined }), policy());
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('no_send_history');
	});
});

describe('sunset safety — a brand-new contact is structurally unsuppressable', () => {
	it('holds a contact created yesterday', () => {
		const v = evaluateSunset(
			facts({ createdAt: daysAgo(1), firstMessagedAt: daysAgo(1) }),
			policy()
		);
		expect(v.action).toBe('hold');
	});

	it('holds when tenure is short even if the quiet clock looks long', () => {
		// A backdated first-send row (bad import, replayed webhook) must not be
		// able to age a 20-day-old contact past a 270-day window.
		const v = evaluateSunset(
			facts({ createdAt: daysAgo(20), firstMessagedAt: daysAgo(400) }),
			policy()
		);
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('insufficient_tenure');
	});

	it('holds when the measurement span is short even if the row is old', () => {
		const v = evaluateSunset(
			facts({ createdAt: daysAgo(900), firstMessagedAt: daysAgo(20) }),
			policy()
		);
		expect(v.action).toBe('hold');
	});

	it('never suppresses at any tenure below the suppression window', () => {
		for (let tenure = 0; tenure < SUNSET_POLICY_DEFAULTS.suppressAfterDays; tenure += 7) {
			const v = evaluateSunset(
				facts({ createdAt: daysAgo(tenure), firstMessagedAt: daysAgo(tenure) }),
				policy()
			);
			expect(v.action).not.toBe('suppress');
		}
	});
});

describe('sunset safety — a bad clock never fires', () => {
	const hostile = [
		{ label: 'NaN now', overrides: { now: Number.NaN } },
		{ label: 'Infinity now', overrides: { now: Number.POSITIVE_INFINITY } },
		{ label: 'zero now', overrides: { now: 0 } },
		{ label: 'negative now', overrides: { now: -1 } },
		{ label: 'future createdAt', overrides: { createdAt: NOW + 90 * DAY } },
		{ label: 'NaN createdAt', overrides: { createdAt: Number.NaN } },
		{ label: 'future firstMessagedAt', overrides: { firstMessagedAt: NOW + DAY } },
		{ label: 'future lastEngagementAt', overrides: { lastEngagementAt: NOW + 400 * DAY } },
		{ label: 'NaN lastEngagementAt', overrides: { lastEngagementAt: Number.NaN } },
		{ label: 'negative firstMessagedAt', overrides: { firstMessagedAt: -5 } },
	];

	for (const { label, overrides } of hostile) {
		it(`holds on ${label}`, () => {
			const v = evaluateSunset(facts(overrides), policy());
			expect(v.action).toBe('hold');
			expect(v.reason).toBe('clock_skew');
		});
	}

	it('holds on a hostile policy crafted to force an immediate suppression', () => {
		const v = evaluateSunset(facts({ lastEngagementAt: daysAgo(1) }), {
			enabled: true,
			reengageAfterDays: 0,
			suppressAfterDays: 0,
		});
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('invalid_policy');
	});
});

describe('sunset safety — contacts that must never be touched', () => {
	it('holds a contact with no email address', () => {
		const v = evaluateSunset(facts({ hasEmail: false, lastEngagementAt: daysAgo(999) }), policy());
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('no_email');
	});

	it('holds a globally-unsubscribed contact (transactional mail must survive)', () => {
		const v = evaluateSunset(facts({ isGloballyUnsubscribed: true }), policy());
		expect(v.action).toBe('hold');
		expect(v.reason).toBe('globally_unsubscribed');
	});
});

describe('sunset safety — auto-suppression NEVER deletes data', () => {
	it('leaves the contact, its timeline and its topics intact', async () => {
		const t = convexTest(schema, modules);

		const { contactId, activityCount, topicCount } = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'quiet@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			const topicId = await ctx.db.insert('topics', { name: 'News', createdAt: daysAgo(500) });
			await ctx.db.insert('contactTopics', {
				contactId: id,
				topicId,
				addedAt: daysAgo(500),
			});
			for (const at of [daysAgo(480), daysAgo(400), daysAgo(320)]) {
				await ctx.db.insert('contactActivities', {
					contactId: id,
					activityType: 'email_sent',
					occurredAt: at,
				});
			}
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', id))
				.collect();
			const topics = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', id))
				.collect();
			return {
				contactId: id,
				activityCount: activities.length,
				topicCount: topics.length,
			};
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

		expect(applied.verdict.action).toBe('suppress');

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			expect(contact).not.toBeNull();
			expect(contact?.deletedAt).toBeUndefined();
			expect(contact?.email).toBe('quiet@example.com');
			expect(contact?.sunsetStage).toBe('suppressed');

			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(activities.length).toBe(activityCount);

			const topics = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(topics.length).toBe(topicCount);
		});
	});

	it('does not suppress a contact whose only history is its creation', async () => {
		const t = convexTest(schema, modules);

		const contactId = await t.run(async (ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'fresh@example.com',
					createdAt: daysAgo(2),
					updatedAt: daysAgo(2),
				})
			)
		);

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
		expect(applied.verdict.reason).toBe('no_send_history');

		await t.run(async (ctx) => {
			const blocked = await ctx.db.query('blockedEmails').collect();
			expect(blocked).toHaveLength(0);
		});
	});
});
