import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';

// The audience-dashboard analytics are `authedQuery`s gated on
// `requireOrgMember`; stub it so they run as an authenticated org member
// without a full BetterAuth session.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../../**/*.*s');

async function insertContact(
	t: ReturnType<typeof convexTest>,
	createdAt: number,
): Promise<Id<'contacts'>> {
	return t.run((ctx) =>
		ctx.db.insert('contacts', {
			email: `c-${createdAt}-${Math.random()}@example.com`,
			source: 'api',
			doiStatus: 'not_required',
			createdAt,
			updatedAt: createdAt,
		}),
	);
}

describe('contacts.analytics.getTopTopics — denormalized counts', () => {
	it('reports contactCount from cachedMemberCount without collecting the membership set', async () => {
		const t = convexTest(schema, modules);

		// A topic whose denormalized count says 5000 members but has ZERO
		// contactTopics rows. If the query still counted memberships via
		// `.collect()` it would report 0; reading the denormalized counter
		// reports 5000. This proves the unbounded membership scan is gone.
		await t.run((ctx) =>
			ctx.db.insert('topics', {
				name: 'Denorm topic',
				cachedMemberCount: 5000,
				createdAt: Date.now(),
			}),
		);

		const topics = await t.query(api.contacts.analytics.getTopTopics, { limit: 5 });
		const denorm = topics.find((topic) => topic.name === 'Denorm topic');
		expect(denorm?.contactCount).toBe(5000);
	});

	it('falls back to the real membership count when no cache is present', async () => {
		const t = convexTest(schema, modules);

		const topicId = await t.run((ctx) =>
			ctx.db.insert('topics', { name: 'Uncached topic', createdAt: Date.now() }),
		);
		// Two real memberships, no cachedMemberCount.
		for (let i = 0; i < 2; i++) {
			const contactId = await insertContact(t, Date.now());
			await t.run((ctx) =>
				ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() }),
			);
		}

		const topics = await t.query(api.contacts.analytics.getTopTopics, { limit: 5 });
		const uncached = topics.find((topic) => topic.name === 'Uncached topic');
		expect(uncached?.contactCount).toBe(2);
	});
});

describe('contacts.analytics.getSubscriberGrowth — bounded scan', () => {
	it('returns a { days, truncated } series without unbounded-collecting', async () => {
		const t = convexTest(schema, modules);

		const now = Date.now();
		const oneDay = 24 * 60 * 60 * 1000;
		// Three contacts created within the last 30 days.
		await insertContact(t, now - oneDay);
		await insertContact(t, now - oneDay);
		await insertContact(t, now - 2 * oneDay);
		// One contact outside the 30-day window must not be counted.
		await insertContact(t, now - 40 * oneDay);

		const result = await t.query(api.contacts.analytics.getSubscriberGrowth, {});

		// New object shape: a 30-entry day series plus a truncation flag.
		expect(result.truncated).toBe(false);
		expect(result.days).toHaveLength(30);
		const total = result.days.reduce((sum, day) => sum + day.count, 0);
		expect(total).toBe(3);
	});
});
