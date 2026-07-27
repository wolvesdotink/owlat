import { describe, it, expect } from 'vitest';
import { createTestContact } from '../../__tests__/factories';
import {
	SUNSET_POLICY_DEFAULTS,
	SUNSET_REENGAGE_AFTER_DAYS,
	SUNSET_SUPPRESS_AFTER_DAYS,
	resolveSunsetPolicy,
} from '../sunsetPolicy';
import {
	evaluateAndApplySunset,
	loadSunsetPolicyRows,
	resolveSunsetPolicyForContact,
} from '../sunsetEngine';
import { NOW, daysAgo, harness } from './sunsetFixtures';

/**
 * THE CONSERVATIVE DEFAULT IS ON OUT OF THE BOX (deliverability plan P4-4). A
 * hygiene feature that ships disabled protects nobody, so an install with an
 * empty `sunsetPolicies` table must already be running 180/270 — not waiting for
 * an operator to discover a setting.
 */

function harness() {
	return convexTest(schema, modules);
}

describe('sunset defaults', () => {
	it('is enabled at 180 / 270', () => {
		expect(SUNSET_POLICY_DEFAULTS).toEqual({
			isEnabled: true,
			reengageAfterDays: 180,
			suppressAfterDays: 270,
		});
		expect(SUNSET_REENGAGE_AFTER_DAYS).toBe(180);
		expect(SUNSET_SUPPRESS_AFTER_DAYS).toBe(270);
	});

	it('freezes the default object so a caller cannot mutate the shipped policy', () => {
		expect(Object.isFrozen(SUNSET_POLICY_DEFAULTS)).toBe(true);
	});

	it('resolves to the default with nothing configured', () => {
		expect(resolveSunsetPolicy({})).toEqual({ ...SUNSET_POLICY_DEFAULTS });
	});

	it('an empty sunsetPolicies table is the shipped configuration, not a missing setup', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'default@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			)
		);

		const policy = await t.run(async (ctx) => {
			const rows = await loadSunsetPolicyRows(ctx);
			expect(rows).toHaveLength(0);
			return await resolveSunsetPolicyForContact(ctx, contactId, rows);
		});
		expect(policy).toEqual({ ...SUNSET_POLICY_DEFAULTS });
	});

	it('protects a fresh install: a 300-day-quiet contact is suppressed with zero configuration', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'unconfigured@example.com',
					createdAt: daysAgo(400),
					updatedAt: daysAgo(400),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(300),
			});
			return id;
		});

		const applied = await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			if (!contact) throw new Error('fixture contact missing');
			const rows = await loadSunsetPolicyRows(ctx);
			const policy = await resolveSunsetPolicyForContact(ctx, contact._id, rows);
			return await evaluateAndApplySunset(ctx, { contact, policy, now: NOW });
		});

		expect(applied.verdict.action).toBe('suppress');
	});

	it('a topic override layers onto the default rather than replacing it', async () => {
		const t = harness();
		const { contactId } = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'topical@example.com',
					createdAt: daysAgo(400),
					updatedAt: daysAgo(400),
				})
			);
			const topicId = await ctx.db.insert('topics', { name: 'Slow list', createdAt: daysAgo(400) });
			await ctx.db.insert('contactTopics', { contactId: id, topicId, addedAt: daysAgo(400) });
			await ctx.db.insert('sunsetPolicies', {
				topicId,
				suppressAfterDays: 540,
				createdAt: daysAgo(10),
				updatedAt: daysAgo(10),
			});
			return { contactId: id };
		});

		const policy = await t.run(async (ctx) => {
			const rows = await loadSunsetPolicyRows(ctx);
			return await resolveSunsetPolicyForContact(ctx, contactId, rows);
		});

		// enabled + the re-engagement window are INHERITED; only the configured
		// field moves.
		expect(policy).toEqual({ isEnabled: true, reengageAfterDays: 180, suppressAfterDays: 540 });
	});

	it('a deployment-wide opt-out disables the engine everywhere', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'optout@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: daysAgo(480),
			});
			await ctx.db.insert('sunsetPolicies', {
				isEnabled: false,
				createdAt: daysAgo(10),
				updatedAt: daysAgo(10),
			});
			return id;
		});

		const applied = await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			if (!contact) throw new Error('fixture contact missing');
			const rows = await loadSunsetPolicyRows(ctx);
			const policy = await resolveSunsetPolicyForContact(ctx, contact._id, rows);
			return await evaluateAndApplySunset(ctx, { contact, policy, now: NOW });
		});

		expect(applied.applied).toBe(false);
		expect(applied.verdict.reason).toBe('policy_disabled');
	});
});

describe('sunset defaults — a deployment-wide opt-out reaches topic members too', () => {
	/**
	 * The opt-out case above happens to cover a contact in ZERO topics, which
	 * takes `resolveSunsetPolicy`'s early return and never exercises the
	 * per-topic merge at all. These two pin the answer for a contact that IS in a
	 * topic: a global `isEnabled: false` wins whether or not the topic has a row,
	 * and whether or not that row says the engine is on. "Most lenient wins"
	 * includes the deployment-wide policy — an operator who turned the engine off
	 * everywhere means everywhere.
	 */
	async function seedTopicMember(
		t: ReturnType<typeof harness>,
		topicRow: { isEnabled?: boolean } | null
	) {
		return await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `member-${topicRow === null ? 'norow' : String(topicRow.isEnabled)}@example.com`,
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			const topicId = await ctx.db.insert('topics', { name: 'News', createdAt: daysAgo(500) });
			await ctx.db.insert('contactTopics', { contactId: id, topicId, addedAt: daysAgo(500) });
			await ctx.db.insert('sunsetPolicies', {
				isEnabled: false,
				createdAt: daysAgo(10),
				updatedAt: daysAgo(10),
			});
			if (topicRow !== null) {
				await ctx.db.insert('sunsetPolicies', {
					topicId,
					...topicRow,
					createdAt: daysAgo(10),
					updatedAt: daysAgo(10),
				});
			}
			return id;
		});
	}

	for (const [label, topicRow] of [
		['no row of its own', null],
		['a row that inherits', {}],
		['a row that explicitly turns the engine ON', { isEnabled: true }],
	] as const) {
		it(`stays disabled for a topic member with ${label}`, async () => {
			const t = harness();
			const contactId = await seedTopicMember(t, topicRow);

			const policy = await t.run(async (ctx) => {
				const rows = await loadSunsetPolicyRows(ctx);
				return await resolveSunsetPolicyForContact(ctx, contactId, rows);
			});

			expect(policy.isEnabled).toBe(false);
		});
	}

	it('a topic opting out still disables the engine while the global row says ON', async () => {
		const t = harness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'topic-optout@example.com',
					createdAt: daysAgo(500),
					updatedAt: daysAgo(500),
				})
			);
			const topicId = await ctx.db.insert('topics', { name: 'Quiet', createdAt: daysAgo(500) });
			await ctx.db.insert('contactTopics', { contactId: id, topicId, addedAt: daysAgo(500) });
			await ctx.db.insert('sunsetPolicies', {
				topicId,
				isEnabled: false,
				createdAt: daysAgo(10),
				updatedAt: daysAgo(10),
			});
			return id;
		});

		const policy = await t.run(async (ctx) => {
			const rows = await loadSunsetPolicyRows(ctx);
			return await resolveSunsetPolicyForContact(ctx, contactId, rows);
		});

		expect(policy.isEnabled).toBe(false);
	});
});
