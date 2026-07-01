import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestCampaign, createTestEmailTemplate } from './factories';
import type { Id } from '../_generated/dataModel';
import type { OrganizationRole } from '../lib/sessionOrganization';

/**
 * Role-enforcement integration tests for the four campaign-edit mutations
 * (updateBasics, updateAudience, updateContent, duplicate).
 *
 * Before the C3 fix, these mutations called `getMutationContext(ctx)` and
 * discarded the result under `_session`, leaving role unchecked. They are now
 * gated by `requirePermission(hasPermission(session.role, 'campaigns:manage'), ...)`,
 * so an `editor` role must be rejected while `owner` / `admin` succeed.
 */

let mockRole: OrganizationRole = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual =
		await vi.importActual<typeof import('../lib/sessionOrganization')>(
			'../lib/sessionOrganization'
		);
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({ userId: 'test-user', role: mockRole })),
		requireOrgPermission: vi.fn().mockImplementation(
			async (_ctx: unknown, permission: string, message?: string) => {
				const mod: typeof import('../lib/sessionOrganization') = actual as typeof import('../lib/sessionOrganization');
				mod.requirePermission(
					mod.hasPermission(
						mockRole as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1],
					),
					message,
				);
				return { userId: 'test-user', role: mockRole };
			},
		),
	};
});

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	mockRole = 'owner';
});

async function seedCampaign(t: ReturnType<typeof convexTest>): Promise<Id<'campaigns'>> {
	let campaignId!: Id<'campaigns'>;
	await t.run(async (ctx) => {
		campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({ status: 'draft', name: 'C1', subject: 'S1' })
		);
	});
	return campaignId;
}

describe('campaigns.updateBasics — role enforcement', () => {
	it('rejects editor role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);

		mockRole = 'editor';
		await expect(
			t.mutation(api.campaigns.campaigns.updateBasics, {
				campaignId,
				name: 'Hacked',
			})
		).rejects.toThrow(/owners and admins/);
	});

	it('allows admin role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);

		mockRole = 'admin';
		await expect(
			t.mutation(api.campaigns.campaigns.updateBasics, {
				campaignId,
				name: 'Renamed by admin',
			})
		).resolves.toBe(campaignId);
	});

	it('allows owner role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);

		mockRole = 'owner';
		await expect(
			t.mutation(api.campaigns.campaigns.updateBasics, {
				campaignId,
				name: 'Renamed by owner',
			})
		).resolves.toBe(campaignId);
	});
});

describe('campaigns.updateAudience — role enforcement', () => {
	it('rejects editor role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);
		let topicId!: Id<'topics'>;
		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'General',
				description: '',
				isDefault: false,
				createdAt: Date.now(),
			});
		});

		mockRole = 'editor';
		await expect(
			t.mutation(api.campaigns.campaigns.updateAudience, {
				campaignId,
				audience: { kind: 'topic', topicId },
			})
		).rejects.toThrow(/owners and admins/);
	});
});

describe('campaigns.updateContent — role enforcement', () => {
	it('rejects editor role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);
		let templateId!: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		});

		mockRole = 'editor';
		await expect(
			t.mutation(api.campaigns.campaigns.updateContent, {
				campaignId,
				emailTemplateId: templateId,
				subject: 'Hacked subject',
			})
		).rejects.toThrow(/owners and admins/);
	});

	it('allows owner role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);
		let templateId!: Id<'emailTemplates'>;
		await t.run(async (ctx) => {
			templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		});

		mockRole = 'owner';
		await expect(
			t.mutation(api.campaigns.campaigns.updateContent, {
				campaignId,
				emailTemplateId: templateId,
				subject: 'Legit subject',
			})
		).resolves.toBe(campaignId);
	});
});

describe('campaigns.duplicate — role enforcement', () => {
	it('rejects editor role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);

		mockRole = 'editor';
		await expect(
			t.mutation(api.campaigns.campaigns.duplicate, { campaignId })
		).rejects.toThrow(/owners and admins/);
	});

	it('allows admin role', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedCampaign(t);

		mockRole = 'admin';
		const newId = await t.mutation(api.campaigns.campaigns.duplicate, { campaignId });
		expect(newId).toBeTruthy();
		expect(newId).not.toBe(campaignId);
	});
});
