/**
 * `campaigns.organization.listAttentionCandidates` — the org-wide scan that
 * feeds the command center's "Needs attention" pill. It must return exactly the
 * campaigns in the four transient candidate statuses (scheduled / sending /
 * cancelled / pending_review) and never the high-volume browse states
 * (draft / sent), and it must project each row down to the light field set the
 * client classifier reads (no archived HTML over the live subscription).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { createTestCampaign, enableFeatures } from '../../__tests__/factories';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

// Vite canonicalizes glob keys for files in this subtree: a sibling at
// convex/campaigns/X is keyed as '../X' rather than '../../campaigns/X'.
// convex-test computes its lookup prefix from '../../_generated/...', so the
// canonicalized keys would never match. Re-prefix the canonicalized half.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../campaigns/' + key.slice(3), val];
		}
		return [key, val];
	})
);

describe('campaigns.organization.listAttentionCandidates', () => {
	it('returns exactly the four candidate statuses and excludes draft/sent', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);

		await t.run(async (ctx) => {
			for (const status of [
				'draft',
				'scheduled',
				'sending',
				'sent',
				'cancelled',
				'pending_review',
			] as const) {
				await ctx.db.insert(
					'campaigns',
					createTestCampaign({ name: `${status} campaign`, status })
				);
			}
		});

		const candidates = await t.query(api.campaigns.organization.listAttentionCandidates, {});

		const statuses = candidates.map((c) => c.status).sort();
		expect(statuses).toEqual(['cancelled', 'pending_review', 'scheduled', 'sending']);
		expect(statuses).not.toContain('draft');
		expect(statuses).not.toContain('sent');
	});

	it('projects each row to the light field set (no archived HTML payload)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Heavy cancelled',
					status: 'cancelled',
					archiveHtmlContent: '<html>a very large archived body</html>',
				})
			);
		});

		const candidates = await t.query(api.campaigns.organization.listAttentionCandidates, {});
		expect(candidates).toHaveLength(1);
		const row = candidates[0]!;
		expect(row.name).toBe('Heavy cancelled');
		// Exact-shape assertion: the row carries precisely the projected field
		// set — no more (so no heavy `archiveHtmlContent` / `audience` /
		// `abTestConfig` payload crosses the wire) and no less. Any leaked or
		// dropped field fails here, unlike a handful of `in` checks that pass
		// vacuously when the factory omits the field to begin with.
		const expectedProjectedFields = [
			'_id',
			'name',
			'subject',
			'status',
			'scheduledAt',
			'sentAt',
			'isABTest',
			'abTestStatus',
			'abWinner',
			'contentBlockReason',
			'updatedAt',
			'statsSent',
			'statsDelivered',
			'statsOpened',
			'statsClicked',
			'abVariantBSent',
			'abVariantBOpened',
		];
		expect(Object.keys(row).sort()).toEqual([...expectedProjectedFields].sort());
	});

	it('returns an empty list when nothing sits in a candidate status', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);

		await t.run(async (ctx) => {
			await ctx.db.insert('campaigns', createTestCampaign({ status: 'draft' }));
			await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
		});

		const candidates = await t.query(api.campaigns.organization.listAttentionCandidates, {});
		expect(candidates).toEqual([]);
	});
});
