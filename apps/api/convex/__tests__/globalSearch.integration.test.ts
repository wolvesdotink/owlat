import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import {
	createTestContact,
	createTestEmailTemplate,
	createTestTransactionalEmail,
	createTestCampaign,
} from './factories';

/**
 * globalSearch.search — the dashboard Cmd-K palette. It fans a query across the
 * contacts / emailTemplates / transactionalEmails / campaigns search indexes and
 * shapes each hit into a typed, deep-linkable result. Only the soft-delete/PII
 * branch was covered before; this exercises the email + transactional + campaign
 * branches, the result mapping (titles, subtitles, URLs), the short-query
 * short-circuit, and the per-category limit.
 */

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('admin-1'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');
const TOKEN = 'zzglobaltoken';

describe('globalSearch.search', () => {
	it('matches across all categories and shapes deep-linkable results', async () => {
		const t = convexTest(schema, modules);

		const ids = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					searchableText: `${TOKEN} alice smith`,
					firstName: 'Alice',
					lastName: 'Smith',
					email: 'alice@example.com',
				})
			);
			const templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({
					searchableText: TOKEN,
					name: 'Spring Promo',
					subject: 'Big sale',
				})
			);
			const txId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					searchableText: TOKEN,
					name: 'Welcome Email',
					subject: 'Hi there',
					slug: 'welcome-email',
				})
			);
			const campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ searchableText: TOKEN, name: 'June Blast', subject: 'Newsletter' })
			);
			// Noise rows that must NOT match.
			await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ searchableText: 'unrelated' })
			);
			await ctx.db.insert('campaigns', createTestCampaign({ searchableText: 'unrelated' }));
			return { contactId, templateId, txId, campaignId };
		});

		const res = await t.query(api.globalSearch.search, { query: TOKEN });

		// Contact
		expect(res.contacts).toHaveLength(1);
		expect(res.contacts[0]).toMatchObject({
			id: ids.contactId,
			type: 'contact',
			title: 'Alice Smith',
			subtitle: 'alice@example.com',
			url: `/dashboard/contacts/${ids.contactId}`,
		});

		// Emails = templates + transactional, merged.
		const template = res.emails.find((e) => e.id === ids.templateId);
		expect(template).toMatchObject({
			type: 'email',
			title: 'Spring Promo',
			subtitle: 'Big sale',
			url: `/dashboard/send/emails/${ids.templateId}/edit`,
		});
		const tx = res.emails.find((e) => e.id === ids.txId);
		expect(tx).toMatchObject({
			type: 'email',
			title: 'Welcome Email',
			subtitle: 'Hi there (welcome-email)',
			url: `/dashboard/send/transactional/${ids.txId}/edit`,
		});

		// Campaign
		expect(res.campaigns).toHaveLength(1);
		expect(res.campaigns[0]).toMatchObject({
			id: ids.campaignId,
			type: 'campaign',
			title: 'June Blast',
			subtitle: 'Newsletter',
			url: `/dashboard/campaigns/${ids.campaignId}`,
		});
	});

	it('falls back to the email as the contact title when there is no name', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'contacts',
				createTestContact({
					searchableText: TOKEN,
					firstName: undefined,
					lastName: undefined,
					email: 'noname@example.com',
				})
			);
		});

		const res = await t.query(api.globalSearch.search, { query: TOKEN });
		expect(res.contacts[0]!.title).toBe('noname@example.com');
	});

	it('falls back to status as the campaign subtitle when no subject', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					searchableText: TOKEN,
					name: 'Draft Blast',
					subject: undefined,
					status: 'draft',
				})
			);
		});

		const res = await t.query(api.globalSearch.search, { query: TOKEN });
		expect(res.campaigns[0]!.subtitle).toBe('draft');
	});

	it('returns all-empty for a query shorter than 2 characters', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('campaigns', createTestCampaign({ searchableText: TOKEN }));
		});

		const res = await t.query(api.globalSearch.search, { query: 'z' });
		expect(res).toEqual({ contacts: [], emails: [], campaigns: [] });
	});

	it('respects the per-category limit', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 4; i++) {
				await ctx.db.insert(
					'campaigns',
					createTestCampaign({ searchableText: TOKEN, name: `Blast ${i}` })
				);
			}
		});

		const res = await t.query(api.globalSearch.search, { query: TOKEN, limit: 2 });
		expect(res.campaigns).toHaveLength(2);
	});
});
