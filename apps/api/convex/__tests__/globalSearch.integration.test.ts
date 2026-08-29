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
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';

/**
 * globalSearch.search — the dashboard Cmd-K palette. It fans a query across the
 * contacts / emailTemplates / transactionalEmails / campaigns / mailMessages
 * search indexes and shapes each hit into a typed, deep-linkable result. Only
 * the soft-delete/PII branch was covered before; this exercises the email +
 * transactional + campaign branches, the result mapping (titles, subtitles,
 * URLs), the short-query short-circuit, and the per-category limit.
 *
 * Mail is the one per-USER category (every other one is org-wide), so its
 * assertions carry the scoping: another user's mailbox, Spam and Trash must
 * never appear in a palette that anyone can open from any screen.
 */

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('admin-1'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		// The mail branch derives the caller's mailboxes from the session rather
		// than from an argument, so it needs the full session, not just the id.
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'admin-1',
			role: 'owner',
			activeOrganizationId: 'org-1',
		}),
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
		expect(res).toEqual({ contacts: [], emails: [], campaigns: [], mail: [] });
	});

	it('surfaces mail from every mailbox the caller can read, newest first', async () => {
		const t = convexTest(schema, modules);
		const personal = await seedMailbox(t, { userId: 'admin-1', address: 'a@hinterland.camp' });
		const team = await seedMailbox(t, { userId: 'admin-1', address: 'team@hinterland.camp' });
		await seedFolder(t, personal);
		await seedFolder(t, team);
		const older = await seedMessage(t, personal, {
			subject: `${TOKEN} older`,
			snippet: `${TOKEN} older`,
			fromName: 'Ada Lovelace',
			receivedAt: 1_000,
		});
		const newer = await seedMessage(t, team, {
			subject: `${TOKEN} newer`,
			snippet: `${TOKEN} newer`,
			receivedAt: 2_000,
		});

		const res = await t.query(api.globalSearch.search, { query: TOKEN });

		expect(res.mail.map((m) => m.id)).toEqual([newer, older]);
		expect(res.mail[1]).toMatchObject({
			id: older,
			type: 'mail',
			title: `${TOKEN} older`,
			subtitle: `Ada Lovelace · ${TOKEN} older`,
			url: `/dashboard/postbox/inbox/${older}`,
			mailboxId: personal,
		});
	});

	it('never surfaces another user’s mail, spam, or trash', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedMailbox(t, { userId: 'admin-1', address: 'a@hinterland.camp' });
		const theirs = await seedMailbox(t, { userId: 'someone-else', address: 'b@hinterland.camp' });
		await seedFolder(t, mine);
		await seedFolder(t, mine, 'spam');
		await seedFolder(t, mine, 'trash');
		await seedFolder(t, theirs);
		await seedMessage(t, mine, { subject: `${TOKEN} junk`, snippet: TOKEN, role: 'spam' });
		await seedMessage(t, mine, { subject: `${TOKEN} deleted`, snippet: TOKEN, role: 'trash' });
		await seedMessage(t, theirs, { subject: `${TOKEN} private`, snippet: TOKEN });

		const res = await t.query(api.globalSearch.search, { query: TOKEN });

		expect(res.mail).toEqual([]);
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
