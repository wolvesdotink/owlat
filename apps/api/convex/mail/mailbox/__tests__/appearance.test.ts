/**
 * An inbox's mark: the icon or emoji its chip shows in place of initials.
 *
 *   - an owner sets an icon from the fixed set or one emoji, and clears it;
 *   - anything else (a word, two emoji, text around an emoji) is refused;
 *   - a member of a shared inbox cannot change it;
 *   - the accessible-inbox query returns it with the connected provider.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../../schema';
import { api } from '../../../_generated/api';
import { modules, seedMailbox } from '../../../mail/__tests__/helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
	orgId: 'org-1',
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.orgId,
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

async function sharedInbox() {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, {
		userId: 'user-A',
		scope: 'shared',
		address: 'support@owlat.test',
	});
	await t.run(async (ctx) =>
		ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: 'user-B',
			role: 'member',
			addedBy: 'user-A',
			createdAt: Date.now(),
		})
	);
	sessionMock.userId = 'user-A';
	return { t, mailboxId };
}

describe('inbox mark', () => {
	it('stores an icon from the set, then an emoji, and clears it again', async () => {
		const { t, mailboxId } = await sharedInbox();
		const markOf = async () => (await t.run(async (ctx) => ctx.db.get(mailboxId)))?.mark;

		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: 'shop' });
		expect(await markOf()).toBe('shop');

		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: ' 🦉 ' });
		expect(await markOf()).toBe('🦉');

		// One grapheme, even when it is several code points.
		for (const emoji of ['👩🏽‍💻', '🇩🇪', '❤️', '🏴󠁧󠁢󠁳󠁣󠁴󠁿']) {
			await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: emoji });
			expect(await markOf()).toBe(emoji);
		}

		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: null });
		expect(await markOf()).toBeUndefined();
	});

	it('leaves the mark alone when only the colour changes', async () => {
		const { t, mailboxId } = await sharedInbox();
		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: 'team' });
		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, colorSlot: 2 });
		expect(await t.run(async (ctx) => ctx.db.get(mailboxId))).toMatchObject({
			mark: 'team',
			colorSlot: 2,
		});
	});

	it('refuses anything that is not an icon key or a single emoji', async () => {
		const { t, mailboxId } = await sharedInbox();
		const refused = [
			'',
			' ',
			'W',
			'Wo',
			'rocket',
			'HOME',
			'🦉🦉',
			'a🦉',
			'🦉a',
			'1',
			'\u200D',
			'🦉'.repeat(20),
		];
		for (const mark of refused) {
			await expect(
				t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark })
			).rejects.toThrow();
		}
		expect((await t.run(async (ctx) => ctx.db.get(mailboxId)))?.mark).toBeUndefined();
	});

	it('refuses a member who does not own the inbox', async () => {
		const { t, mailboxId } = await sharedInbox();
		sessionMock.userId = 'user-B';
		await expect(
			t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: 'home' })
		).rejects.toThrow();
		expect((await t.run(async (ctx) => ctx.db.get(mailboxId)))?.mark).toBeUndefined();
	});

	it('returns the mark and a connected account’s provider with each inbox', async () => {
		const { t, mailboxId } = await sharedInbox();
		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, mark: 'work' });
		const gmailId = await seedMailbox(t, {
			userId: 'user-A',
			kind: 'external',
			address: 'ada@gmail.com',
			domain: 'gmail.com',
		});
		const outlookId = await seedMailbox(t, {
			userId: 'user-A',
			kind: 'external',
			address: 'ada@outlook.com',
			domain: 'outlook.com',
		});
		const imapId = await seedMailbox(t, {
			userId: 'user-A',
			kind: 'external',
			address: 'ada@fastmail.com',
			domain: 'fastmail.com',
		});
		await t.run(async (ctx) => {
			const account = (
				mailbox: typeof gmailId,
				fields: { imapHost: string; oauthProvider?: 'google' | 'microsoft' }
			) =>
				ctx.db.insert('externalMailAccounts', {
					userId: 'user-A',
					organizationId: 'org-1',
					mailboxId: mailbox,
					imapHost: fields.imapHost,
					imapPort: 993,
					isImapSecure: true,
					smtpHost: fields.imapHost,
					smtpPort: 465,
					isSmtpSecure: true,
					authMethod: fields.oauthProvider ? 'oauth2' : 'password',
					...(fields.oauthProvider ? { oauthProvider: fields.oauthProvider } : {}),
					imapUsername: 'ada',
					status: 'connected',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			// A Gmail account connected with an app password still names its host.
			const gmailAccount = await account(gmailId, { imapHost: 'imap.gmail.com' });
			const outlookAccount = await account(outlookId, {
				imapHost: 'outlook.office365.com',
				oauthProvider: 'microsoft',
			});
			const imapAccount = await account(imapId, { imapHost: 'imap.fastmail.com' });
			await ctx.db.patch(gmailId, { externalAccountId: gmailAccount });
			await ctx.db.patch(outlookId, { externalAccountId: outlookAccount });
			await ctx.db.patch(imapId, { externalAccountId: imapAccount });
		});

		const rows = await t.query(api.mail.mailbox.queries.accessible, {});
		const byId = new Map(rows.map((row) => [row.mailboxId, row]));
		expect(byId.get(mailboxId)).toMatchObject({ mark: 'work', provider: null });
		expect(byId.get(gmailId)).toMatchObject({ mark: null, provider: 'gmail' });
		expect(byId.get(outlookId)).toMatchObject({ mark: null, provider: 'microsoft' });
		expect(byId.get(imapId)).toMatchObject({ mark: null, provider: null });
	});
});
