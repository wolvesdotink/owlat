import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const testIdentity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

type TimelineRow = { type: string; timestamp: number; data: { _id: string } };

describe('getTimeline keyset pagination', () => {
	it('reaches ALL older entries past the per-source fetch window', async () => {
		const t = convexTest(schema, modules);
		// 120 activities, strictly increasing occurredAt — well past the limit (50)
		// + fetch buffer, so the old newest-N-then-post-filter left the oldest
		// entries permanently unreachable. The fix ranges beforeTimestamp into the
		// by_contact_and_occurred_at index.
		const TOTAL = 120;
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', {
				email: 'tl@x.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (let i = 0; i < TOTAL; i++) {
				await ctx.db.insert('contactActivities', {
					contactId: id,
					activityType: 'email_opened' as const,
					metadata: {},
					occurredAt: 1_000 + i,
				});
			}
			return id;
		});

		const seen = new Set<string>();
		let before: number | undefined = undefined;
		for (let page = 0; page < 10; page++) {
			const result = (await t.withIdentity(testIdentity).query(api.contacts.timeline.getTimeline, {
				contactId,
				limit: 50,
				beforeTimestamp: before,
			})) as TimelineRow[];
			if (result.length === 0) break;
			for (const e of result) {
				if (before !== undefined) expect(e.timestamp).toBeLessThan(before);
				seen.add(String(e.data._id));
			}
			before = result[result.length - 1]!.timestamp;
		}

		expect(seen.size).toBe(TOTAL); // every activity reachable across pages
	});
});
