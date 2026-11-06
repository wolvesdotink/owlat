/**
 * All inboxes and the unified folders (`mail.mailbox.allInboxes`): one system
 * folder of every mailbox the caller reads, merged newest first and paged like
 * one folder, and the live drafts of those mailboxes.
 *
 * What it must get right: the order across mailboxes, a cursor walk that
 * neither skips nor repeats a message (also inside a run of messages that tie
 * on both timestamps), the access boundary (own mailboxes and team-inbox
 * memberships only, even for an org owner who could open any mailbox), a
 * folder id that is not the named mailbox's, snoozed mail, and the role folder
 * ids and provider that `queries.accessible` hands the client to ask with.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';
import { withCreationTime } from '../../__tests__/helpers/creationTimeSeam';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type T = TestConvex<typeof schema>;
type Source = { mailboxId: Id<'mailboxes'>; folderId: Id<'mailFolders'> };

async function seedInbox(t: T, seed: Parameters<typeof seedMailbox>[1] = {}): Promise<Source> {
	const mailboxId = await seedMailbox(t, seed);
	return { mailboxId, folderId: await seedFolder(t, mailboxId) };
}

async function joinTeamInbox(t: T, mailboxId: Id<'mailboxes'>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: 'user-A',
			role: 'member',
			addedBy: 'user-B',
			createdAt: Date.now(),
		});
	});
}

async function seedDraft(
	t: T,
	mailboxId: Id<'mailboxes'>,
	seed: { subject: string; lastEditedAt: number; obsoleted?: boolean }
) {
	await t.run((ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['ines@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@owlat.test',
			subject: seed.subject,
			bodyHtml: '<p>hi</p>',
			attachments: [],
			state: 'draft',
			lastEditedAt: seed.lastEditedAt,
			createdAt: seed.lastEditedAt,
			...(seed.obsoleted ? { obsoleted: { at: seed.lastEditedAt, byMessageIds: [] } } : {}),
		})
	);
}

function list(t: T, sources: Source[], extra: { limit?: number; cursor?: string } = {}) {
	return t.query(api.mail.mailbox.allInboxes.listMessages, { sources, ...extra });
}

/** Every page from the top, as the subjects in list order. */
async function walk(t: T, sources: Source[], limit: number): Promise<string[]> {
	const subjects: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await list(t, sources, { limit, ...(cursor ? { cursor } : {}) });
		subjects.push(...page.messages.map((m) => m.subject));
		if (!page.hasMore || !page.nextCursor) return subjects;
		cursor = page.nextCursor;
	}
}

describe('mail.mailbox.allInboxes.listMessages', () => {
	it('merges every Inbox newest first, each row naming its own mailbox, and nothing outside the Inboxes', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const home = await seedInbox(t, { address: 'me@owlat.test' });
		const work = await seedInbox(t, { address: 'me.work@owlat.test' });
		await seedFolder(t, home.mailboxId, 'sent');
		await seedMessage(t, home.mailboxId, { subject: 'home old', receivedAt: now - 3000 });
		await seedMessage(t, work.mailboxId, { subject: 'work new', receivedAt: now - 1000 });
		await seedMessage(t, home.mailboxId, { subject: 'home new', receivedAt: now - 2000 });
		await seedMessage(t, home.mailboxId, { subject: 'sent', role: 'sent', receivedAt: now });

		const page = await list(t, [home, work]);

		expect(page.messages.map((m) => [m.subject, m.mailboxId])).toEqual([
			['work new', work.mailboxId],
			['home new', home.mailboxId],
			['home old', home.mailboxId],
		]);
		expect(page).toMatchObject({ hasMore: false, nextCursor: null });
	});

	it('walks every message once across pages, through a run that ties on both timestamps', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now() - 10_000;
		const home = await seedInbox(t, { address: 'me@owlat.test' });
		const work = await seedInbox(t, { address: 'me.work@owlat.test' });
		await seedMessage(t, home.mailboxId, { subject: 'newest', receivedAt: at + 5000 });
		await withCreationTime(at, async () => {
			for (const n of [1, 2, 3]) {
				await seedMessage(t, home.mailboxId, { subject: `tie home ${n}`, receivedAt: at });
				await seedMessage(t, work.mailboxId, { subject: `tie work ${n}`, receivedAt: at });
			}
		});
		await seedMessage(t, work.mailboxId, { subject: 'oldest', receivedAt: at - 5000 });

		const subjects = await walk(t, [home, work], 2);

		expect(subjects).toHaveLength(8);
		expect(new Set(subjects).size).toBe(8);
		expect(subjects[0]).toBe('newest');
		expect(subjects[7]).toBe('oldest');
	});

	it('walks every message once across pages when they share a receivedAt but not a creation time', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now() - 10_000;
		const home = await seedInbox(t, { address: 'me@owlat.test' });
		for (const n of [1, 2, 3, 4, 5]) {
			await seedMessage(t, home.mailboxId, { subject: `same ${n}`, receivedAt: at });
		}

		const subjects = await walk(t, [home], 2);

		expect([...subjects].sort()).toEqual(['same 1', 'same 2', 'same 3', 'same 4', 'same 5']);
	});

	it('leaves out a mailbox the caller only reaches as an org owner, and keeps a team inbox they belong to', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, { address: 'me@owlat.test' });
		const colleague = await seedInbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const team = await seedInbox(t, {
			userId: 'user-B',
			address: 'support@owlat.test',
			scope: 'shared',
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: team.mailboxId,
				authUserId: 'user-A',
				role: 'member',
				addedBy: 'user-B',
				createdAt: Date.now(),
			});
		});
		await seedMessage(t, mine.mailboxId, { subject: 'mine' });
		await seedMessage(t, colleague.mailboxId, { subject: 'private' });
		await seedMessage(t, team.mailboxId, { subject: 'team' });

		const page = await list(t, [mine, colleague, team]);

		expect(page.messages.map((m) => m.subject).sort()).toEqual(['mine', 'team']);
	});

	it("reads nothing from a folder id that is not the named mailbox's", async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, { address: 'me@owlat.test' });
		const colleague = await seedInbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		await seedMessage(t, colleague.mailboxId, { subject: 'private' });

		const page = await list(t, [{ mailboxId: mine.mailboxId, folderId: colleague.folderId }]);

		expect(page).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});

	it('hides snoozed mail and does not read the folder documents', async () => {
		const t = convexTest(schema, modules);
		const home = await seedInbox(t, { address: 'me@owlat.test' });
		await seedMessage(t, home.mailboxId, { subject: 'visible' });
		const snoozed = await seedMessage(t, home.mailboxId, { subject: 'snoozed' });
		await t.run(async (ctx) => {
			await ctx.db.patch(snoozed, { snoozedUntil: Date.now() + 3_600_000 });
			await ctx.db.delete(home.folderId);
		});

		const page = await list(t, [home]);

		expect(page.messages.map((m) => m.subject)).toEqual(['visible']);
	});

	it('merges the Sent folders of two mailboxes, and the Trash folders, without crossing into the Inbox', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const home = await seedInbox(t, { address: 'me@owlat.test' });
		const work = await seedInbox(t, { address: 'me.work@owlat.test' });
		const sent = {
			home: { mailboxId: home.mailboxId, folderId: await seedFolder(t, home.mailboxId, 'sent') },
			work: { mailboxId: work.mailboxId, folderId: await seedFolder(t, work.mailboxId, 'sent') },
		};
		const trash = {
			home: { mailboxId: home.mailboxId, folderId: await seedFolder(t, home.mailboxId, 'trash') },
			work: { mailboxId: work.mailboxId, folderId: await seedFolder(t, work.mailboxId, 'trash') },
		};
		await seedMessage(t, home.mailboxId, {
			subject: 'sent home',
			role: 'sent',
			receivedAt: now - 3000,
		});
		await seedMessage(t, work.mailboxId, {
			subject: 'sent work',
			role: 'sent',
			receivedAt: now - 1000,
		});
		await seedMessage(t, work.mailboxId, {
			subject: 'binned work',
			role: 'trash',
			receivedAt: now - 500,
		});
		await seedMessage(t, home.mailboxId, {
			subject: 'binned home',
			role: 'trash',
			receivedAt: now - 200,
		});
		await seedMessage(t, home.mailboxId, { subject: 'inbox', receivedAt: now });

		const sentPage = await list(t, [sent.home, sent.work]);
		const trashPage = await list(t, [trash.home, trash.work], { limit: 1 });
		const trashRest = await list(t, [trash.home, trash.work], {
			limit: 1,
			cursor: trashPage.nextCursor ?? undefined,
		});

		expect(sentPage.messages.map((m) => [m.subject, m.mailboxId])).toEqual([
			['sent work', work.mailboxId],
			['sent home', home.mailboxId],
		]);
		expect(trashPage.messages.map((m) => m.subject)).toEqual(['binned home']);
		expect(trashPage.hasMore).toBe(true);
		expect(trashRest.messages.map((m) => m.subject)).toEqual(['binned work']);
	});

	it("reads nothing from another mailbox's Sent folder named under the caller's mailbox", async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, { address: 'me@owlat.test' });
		await seedFolder(t, mine.mailboxId, 'sent');
		const colleague = await seedInbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const colleagueSent = await seedFolder(t, colleague.mailboxId, 'sent');
		await seedMessage(t, colleague.mailboxId, { subject: 'private', role: 'sent' });

		const page = await list(t, [{ mailboxId: mine.mailboxId, folderId: colleagueSent }]);

		expect(page).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});
});

describe('mail.mailbox.allInboxes.listDrafts', () => {
	it('merges the live drafts of the mailboxes the caller reads, last edited first', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const mine = await seedInbox(t, { address: 'me@owlat.test' });
		const colleague = await seedInbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const team = await seedInbox(t, {
			userId: 'user-B',
			address: 'support@owlat.test',
			scope: 'shared',
		});
		await joinTeamInbox(t, team.mailboxId);
		await seedDraft(t, mine.mailboxId, { subject: 'mine old', lastEditedAt: now - 3000 });
		await seedDraft(t, team.mailboxId, { subject: 'team', lastEditedAt: now - 2000 });
		await seedDraft(t, mine.mailboxId, { subject: 'mine new', lastEditedAt: now - 1000 });
		await seedDraft(t, mine.mailboxId, { subject: 'answered', lastEditedAt: now, obsoleted: true });
		await seedDraft(t, colleague.mailboxId, { subject: 'private', lastEditedAt: now });

		const drafts = await t.query(api.mail.mailbox.allInboxes.listDrafts, {
			mailboxIds: [mine.mailboxId, colleague.mailboxId, team.mailboxId],
		});

		expect(drafts.map((d) => [d.subject, d.mailboxId])).toEqual([
			['mine new', mine.mailboxId],
			['team', team.mailboxId],
			['mine old', mine.mailboxId],
		]);
	});
});

describe('mail.mailbox.queries.accessible', () => {
	it('names each role folder and the provider a mailbox is reached through', async () => {
		const t = convexTest(schema, modules);
		const hosted = await seedInbox(t, { address: 'me@owlat.test' });
		const hostedSent = await seedFolder(t, hosted.mailboxId, 'sent');
		const connected = await seedInbox(t, { address: 'me@gmail.example', kind: 'external' });
		const connectedTrash = await seedFolder(t, connected.mailboxId, 'trash');
		await t.run(async (ctx) => {
			const now = Date.now();
			const accountId = await ctx.db.insert('externalMailAccounts', {
				userId: 'user-A',
				organizationId: 'org-1',
				mailboxId: connected.mailboxId,
				imapHost: 'IMAP.Gmail.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.gmail.example',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'me@gmail.example',
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.patch(connected.mailboxId, { externalAccountId: accountId });
		});

		const rows = await t.query(api.mail.mailbox.queries.accessible, {});
		const byId = new Map(rows.map((row) => [row.mailboxId, row]));

		expect(byId.get(hosted.mailboxId)).toMatchObject({
			providerHost: null,
			folderIds: {
				inbox: hosted.folderId,
				sent: hostedSent,
				drafts: null,
				archive: null,
				spam: null,
				trash: null,
			},
		});
		expect(byId.get(connected.mailboxId)).toMatchObject({
			isConnected: true,
			providerHost: 'imap.gmail.example',
			folderIds: { inbox: connected.folderId, sent: null, trash: connectedTrash },
		});
	});
});
