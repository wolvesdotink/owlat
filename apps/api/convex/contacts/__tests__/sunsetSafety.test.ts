import { describe, it, expect } from 'vitest';
import { createTestContact } from '../../__tests__/factories';
import {
	evaluateSunset,
	isClockCorroborated,
	latestSunsetInstant,
	SUNSET_MAX_CLOCK_LEAD_MS,
	SUNSET_POLICY_DEFAULTS,
} from '../sunsetPolicy';
import { evaluateAndApplySunset } from '../sunsetEngine';
import { DAY, NOW, daysAgo, facts, harness, policy } from './sunsetFixtures';

/**
 * THE BLOCKING SAFETY SUITE (deliverability plan P4-4).
 *
 * Auto-suppression is the most destructive thing in the plan, so the properties
 * below are not "nice to have": each one asserts that a whole class of bad or
 * missing input makes every suppressing path UNREACHABLE. If one of these fails,
 * the feature is not shippable.
 */

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
			isEnabled: true,
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
		const t = harness();

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
				clock: { now: NOW },
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
		const t = harness();

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
				clock: { now: NOW },
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

describe('sunset safety — a backfilled activity history never fakes disengagement', () => {
	/**
	 * THE INSERTION-ORDER TRAP. `contactActivities` rows are written in whatever
	 * order they arrive, not in `occurredAt` order: a CSV/Mailchimp import or a
	 * replayed webhook batch lands a run of HISTORICAL opens AFTER a genuinely
	 * recent one. Any fact loader that leans on insertion order therefore reports
	 * a stale "newest engagement", which inflates the quiet window and
	 * auto-suppresses a contact that is actively opening our mail.
	 *
	 * The fixture writes the recent open FIRST and then backfills older ones, so
	 * it fails against an insertion-ordered read and passes only against an
	 * `occurredAt`-ordered index.
	 */
	async function seedBackfilledContact(t: ReturnType<typeof harness>, backfillCount: number) {
		return await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'backfilled@example.com',
					createdAt: daysAgo(900),
					updatedAt: daysAgo(900),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(880),
			});
			// The genuinely newest engagement — written before everything older.
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_opened',
				occurredAt: daysAgo(2),
			});
			for (let i = 0; i < backfillCount; i += 1) {
				await ctx.db.insert('contactActivities', {
					contactId: id,
					activityType: 'email_opened',
					// Every one of these is far outside the suppression window.
					occurredAt: daysAgo(500 + i * 10),
				});
			}
			return id;
		});
	}

	for (const backfillCount of [1, 3, 7, 25]) {
		it(`holds when ${backfillCount} historical open(s) are written after a recent one`, async () => {
			const t = harness();
			const contactId = await seedBackfilledContact(t, backfillCount);

			const applied = await t.run(async (ctx) => {
				const contact = await ctx.db.get(contactId);
				if (!contact) throw new Error('fixture contact missing');
				return await evaluateAndApplySunset(ctx, {
					contact,
					policy: { ...SUNSET_POLICY_DEFAULTS },
					clock: { now: NOW },
				});
			});

			expect(applied.verdict.action).toBe('hold');
			expect(applied.verdict.reason).toBe('engaged_recently');
			expect(applied.applied).toBe(false);

			// And nothing was suppressed on the way past.
			await t.run(async (ctx) => {
				const blocked = await ctx.db.query('blockedEmails').collect();
				expect(blocked).toHaveLength(0);
			});
		});
	}

	it('measures the first send from the oldest occurredAt, not the first row written', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'late-import@example.com',
					createdAt: daysAgo(900),
					updatedAt: daysAgo(900),
				})
			);
			// A recent send written first, then the true first send backfilled.
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(10),
			});
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(800),
			});
			return id;
		});

		const applied = await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			if (!contact) throw new Error('fixture contact missing');
			return await evaluateAndApplySunset(ctx, {
				contact,
				policy: { ...SUNSET_POLICY_DEFAULTS },
				clock: { now: NOW },
			});
		});

		// 800 quiet days against a 270-day window: the engine only reaches this
		// verdict if it read the OLDEST send rather than the first row written.
		expect(applied.verdict.action).toBe('suppress');
	});
});

/**
 * ABSENCE OF OPENS IS NOT ABSENCE OF PEOPLE. These go through the real loader,
 * because the defect they guard against was in WHICH activity literals the
 * loader looks at — a pure-fact fixture cannot reproduce it.
 */
describe('sunset safety — an explicit act by the contact resets the quiet clock', () => {
	async function evaluateWithNewestActivity(
		activityType: 'topic_subscribed' | 'topic_confirmed' | 'doi_attested' | 'inbound_received',
		occurredAt: number
	) {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `${activityType}@example.com`,
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(480),
			});
			// The last time they opened anything was 300 days ago.
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_opened',
				occurredAt: daysAgo(300),
			});
			await ctx.db.insert('contactActivities', { contactId: id, activityType, occurredAt });
			return id;
		});

		return await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			if (!contact) throw new Error('fixture contact missing');
			return await evaluateAndApplySunset(ctx, {
				contact,
				policy: { ...SUNSET_POLICY_DEFAULTS },
				clock: { now: NOW },
			});
		});
	}

	for (const activityType of [
		'topic_subscribed',
		'topic_confirmed',
		'doi_attested',
		'inbound_received',
	] as const) {
		it(`holds a 300-day-quiet contact who did ${activityType} two days ago`, async () => {
			const applied = await evaluateWithNewestActivity(activityType, daysAgo(2));
			// Without this the contact is suppressed within the hour — and the
			// confirmation mail they are owed is then blocked as well.
			expect(applied.verdict.action).toBe('hold');
			expect(applied.verdict.reason).toBe('engaged_recently');
			expect(applied.applied).toBe(false);
		});
	}

	it('still suppresses when the consent act is itself older than the window', async () => {
		const applied = await evaluateWithNewestActivity('topic_confirmed', daysAgo(400));
		expect(applied.verdict.action).toBe('suppress');
	});
});

/**
 * A PLAUSIBLE-BUT-WRONG CLOCK. The suite above covers malformed values of `now`;
 * this covers the dangerous case — a `now` that is perfectly well-formed and
 * simply wrong, which makes tenure, quiet days and the measurable span all look
 * covered at the same moment.
 */
describe('sunset safety — a jumped clock never fires', () => {
	async function evaluateAt(now: number, corroboratingInstant: number | undefined) {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'jumped@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
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
				clock: { now, corroboratingInstant },
			});
		});
	}

	it('holds when the host clock has jumped a year ahead of the deployment record', async () => {
		const applied = await evaluateAt(NOW + 365 * DAY, NOW);
		expect(applied.verdict.action).toBe('hold');
		expect(applied.verdict.reason).toBe('clock_skew');
		expect(applied.applied).toBe(false);
	});

	it('writes nothing at all on a jumped clock', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'untouched@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(480),
			});
			return id;
		});
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			if (!contact) throw new Error('fixture contact missing');
			await evaluateAndApplySunset(ctx, {
				contact,
				policy: { ...SUNSET_POLICY_DEFAULTS },
				clock: { now: NOW + 365 * DAY, corroboratingInstant: NOW },
			});
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
			expect(await ctx.db.query('auditLogs').collect()).toHaveLength(0);
			const contact = await ctx.db.get(contactId);
			expect(contact?.sunsetStage).toBeUndefined();
		});
	});

	it('acts normally when the deployment record corroborates the clock', async () => {
		const applied = await evaluateAt(NOW, NOW - DAY);
		expect(applied.verdict.action).toBe('suppress');
	});
});

/**
 * THE CORROBORATION PREDICATE, exercised directly. It is the one guard that
 * validates `now` itself rather than a fact against `now`, and the sweep calls
 * it once per tick before writing anything, so its edges are worth pinning
 * without going through a fixture book.
 */
describe('sunset safety — the clock-corroboration predicate', () => {
	it('trusts a deployment that has never swept (nothing to check against)', () => {
		expect(isClockCorroborated(NOW, undefined)).toBe(true);
	});

	it('rejects a `now` that is not a usable instant', () => {
		expect(isClockCorroborated(Number.NaN, NOW - DAY)).toBe(false);
		expect(isClockCorroborated(0, NOW - DAY)).toBe(false);
		expect(isClockCorroborated(-1, NOW - DAY)).toBe(false);
	});

	it('rejects an unusable corroborating instant rather than ignoring it', () => {
		expect(isClockCorroborated(NOW, Number.NaN)).toBe(false);
		expect(isClockCorroborated(NOW, 0)).toBe(false);
	});

	it('rejects a clock that moved BACKWARDS since the stamp was written', () => {
		expect(isClockCorroborated(NOW, NOW + DAY)).toBe(false);
	});

	it('accepts a lead inside the tolerance and rejects one beyond it', () => {
		expect(isClockCorroborated(NOW, NOW - SUNSET_MAX_CLOCK_LEAD_MS)).toBe(true);
		expect(isClockCorroborated(NOW, NOW - SUNSET_MAX_CLOCK_LEAD_MS - 1)).toBe(false);
	});

	it('takes the LATER of the two corroboration sources, ignoring unusable ones', () => {
		expect(latestSunsetInstant(undefined, undefined)).toBeUndefined();
		expect(latestSunsetInstant(NOW - DAY, undefined)).toBe(NOW - DAY);
		expect(latestSunsetInstant(undefined, NOW - DAY)).toBe(NOW - DAY);
		expect(latestSunsetInstant(NOW - 100 * DAY, NOW - DAY)).toBe(NOW - DAY);
		expect(latestSunsetInstant(Number.NaN, NOW - DAY)).toBe(NOW - DAY);
		expect(latestSunsetInstant(Number.NaN, Number.NaN)).toBeUndefined();
	});
});
