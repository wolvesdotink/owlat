import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
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
import { NOW, daysAgo } from './sunsetFixtures';

/**
 * THE CONSERVATIVE DEFAULT IS ON OUT OF THE BOX (deliverability plan P4-4). A
 * hygiene feature that ships disabled protects nobody, so an install with an
 * empty `sunsetPolicies` table must already be running 180/270 — not waiting for
 * an operator to discover a setting.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const contactsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../contacts/'),
		mod,
	])
);
const modules = { ...rootGlob, ...contactsGlob };

function harness() {
	return convexTest(schema, modules);
}

describe('sunset defaults', () => {
	it('is enabled at 180 / 270', () => {
		expect(SUNSET_POLICY_DEFAULTS).toEqual({
			enabled: true,
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
		expect(policy).toEqual({ enabled: true, reengageAfterDays: 180, suppressAfterDays: 540 });
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
				enabled: false,
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
