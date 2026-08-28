/**
 * Subscriptions panel (mail/subscriptions).
 *
 * Two layers:
 *   1. `groupSubscriptionSenders` — the pure aggregation. Volume, unread,
 *      last-read, best-method selection and the loudest-first ordering, all
 *      testable without a database.
 *   2. `list` / `archiveSenderInInbox` — the bounded read and the archive half
 *      of the batch verb, including mailbox ownership.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import {
	groupSubscriptionSenders,
	subscriptionMethodOf,
	type SubscriptionMessageInput,
} from '../subscriptions';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: sessionMock.userId, role: sessionMock.role })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMock.userId = 'user-A';
	sessionMock.role = 'editor';
});

// ─── Pure aggregation ───────────────────────────────────────────────────────

const MESSAGE_ID = 'm1' as Id<'mailMessages'>;

function message(overrides: Partial<SubscriptionMessageInput> = {}): SubscriptionMessageInput {
	return {
		_id: MESSAGE_ID,
		fromAddress: 'news@northwind.example',
		receivedAt: 1_000,
		flagSeen: false,
		unsubscribe: { httpUrl: 'https://northwind.example/u', oneClick: true },
		...overrides,
	};
}

describe('subscriptionMethodOf', () => {
	it('prefers RFC 8058 one-click over a plain page', () => {
		expect(subscriptionMethodOf({ httpUrl: 'https://x.example/u', oneClick: true })).toBe(
			'one-click'
		);
	});

	it('falls back to the page, then to mailto', () => {
		expect(subscriptionMethodOf({ httpUrl: 'https://x.example/u', oneClick: false })).toBe('http');
		expect(subscriptionMethodOf({ mailtoUrl: 'mailto:u@x.example', oneClick: false })).toBe(
			'mailto'
		);
	});

	it('returns null for a header with no usable target', () => {
		expect(subscriptionMethodOf(undefined)).toBeNull();
		expect(subscriptionMethodOf({ oneClick: true })).toBeNull();
	});
});

describe('groupSubscriptionSenders', () => {
	it('drops mail that carries no unsubscribe target', () => {
		expect(groupSubscriptionSenders([message({ unsubscribe: undefined })])).toEqual([]);
	});

	it('counts volume and unread per sender, case-insensitively', () => {
		const senders = groupSubscriptionSenders([
			message({ receivedAt: 3, flagSeen: false }),
			message({ fromAddress: 'News@Northwind.Example', receivedAt: 2, flagSeen: true }),
			message({ receivedAt: 1, flagSeen: true }),
		]);
		expect(senders).toHaveLength(1);
		expect(senders[0]?.senderEmail).toBe('news@northwind.example');
		expect(senders[0]?.messageCount).toBe(3);
		expect(senders[0]?.unreadCount).toBe(1);
	});

	it('reports the newest READ message as the last-read signal', () => {
		const [sender] = groupSubscriptionSenders([
			message({ receivedAt: 300, flagSeen: false }),
			message({ receivedAt: 200, flagSeen: true }),
			message({ receivedAt: 100, flagSeen: true }),
		]);
		expect(sender?.lastReceivedAt).toBe(300);
		expect(sender?.lastReadAt).toBe(200);
	});

	it('reports never-opened senders with a null last-read', () => {
		const [sender] = groupSubscriptionSenders([
			message({ receivedAt: 2, flagSeen: false }),
			message({ receivedAt: 1, flagSeen: false }),
		]);
		expect(sender?.lastReadAt).toBeNull();
	});

	it('adopts the best method the sender ever offered, not the newest', () => {
		const [sender] = groupSubscriptionSenders([
			message({
				_id: 'newest' as Id<'mailMessages'>,
				receivedAt: 200,
				unsubscribe: { httpUrl: 'https://northwind.example/page', oneClick: false },
			}),
			message({
				_id: 'oneclick' as Id<'mailMessages'>,
				receivedAt: 100,
				unsubscribe: { httpUrl: 'https://northwind.example/u', oneClick: true },
			}),
		]);
		expect(sender?.method).toBe('one-click');
		expect(sender?.actionMessageId).toBe('oneclick');
		expect(sender?.httpUrl).toBe('https://northwind.example/u');
	});

	it('names the sender from its most recent message', () => {
		const [sender] = groupSubscriptionSenders([
			message({ receivedAt: 1, fromName: 'Northwind Weekly' }),
			message({ receivedAt: 2, fromName: 'Northwind Digest' }),
		]);
		expect(sender?.senderName).toBe('Northwind Digest');
	});

	it('sorts loudest first, breaking ties on recency then address', () => {
		const senders = groupSubscriptionSenders([
			message({ fromAddress: 'quiet@a.example', receivedAt: 50 }),
			message({ fromAddress: 'loud@b.example', receivedAt: 10 }),
			message({ fromAddress: 'loud@b.example', receivedAt: 11 }),
			message({ fromAddress: 'quiet@c.example', receivedAt: 90 }),
		]);
		expect(senders.map((s) => s.senderEmail)).toEqual([
			'loud@b.example',
			'quiet@c.example',
			'quiet@a.example',
		]);
	});
});

// ─── Query + archive mutation ───────────────────────────────────────────────

type SeededMailbox = {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	archiveId: Id<'mailFolders'>;
};

async function seedMailboxWithFolders(
	t: TestConvex<typeof schema>,
	userId = 'user-A'
): Promise<SeededMailbox> {
	const mailboxId = await seedMailbox(t, { userId, address: `${userId}@hinterland.camp` });
	const folders = await t.run(async (ctx) => {
		const now = Date.now();
		const makeFolder = (name: string, role: 'inbox' | 'archive') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		return {
			inboxId: await makeFolder('INBOX', 'inbox'),
			archiveId: await makeFolder('Archive', 'archive'),
		};
	});
	return { mailboxId, ...folders };
}

let seedUid = 0;

async function seedListMessage(
	t: TestConvex<typeof schema>,
	seeded: SeededMailbox,
	options: {
		fromAddress: string;
		receivedAt: number;
		flagSeen?: boolean;
		oneClick?: boolean;
		folderId?: Id<'mailFolders'>;
		unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
	}
): Promise<Id<'mailMessages'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const uid = ++seedUid;
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: 'digest',
			participants: [options.fromAddress],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: options.receivedAt,
			firstMessageAt: options.receivedAt,
			latestSnippet: 'digest',
			latestFromAddress: options.fromAddress,
			latestSubject: 'digest',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		return await ctx.db.insert('mailMessages', {
			mailboxId: seeded.mailboxId,
			folderId: options.folderId ?? seeded.inboxId,
			uid,
			modseq: uid,
			rfc822MessageId: `<${uid}@list.example>`,
			threadId,
			fromAddress: options.fromAddress,
			toAddresses: ['user-A@hinterland.camp'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'digest',
			normalizedSubject: 'digest',
			snippet: 'digest',
			rawStorageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: options.flagSeen ?? false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			unsubscribe: options.unsubscribe ?? {
				httpUrl: 'https://list.example/u',
				oneClick: options.oneClick ?? true,
			},
			receivedAt: options.receivedAt,
			internalDate: options.receivedAt,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('mail.subscriptions.list', () => {
	it('groups the mailbox inbox list senders and reports the window', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 10 });
		await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 20,
			flagSeen: true,
		});
		await seedListMessage(t, seeded, { fromAddress: 'deals@b.example', receivedAt: 30 });

		const result = await t.query(api.mail.subscriptions.list, { mailboxId: seeded.mailboxId });
		expect(result.truncated).toBe(false);
		expect(result.scanned).toBe(3);
		expect(result.senders.map((s) => s.senderEmail)).toEqual(['news@a.example', 'deals@b.example']);
		expect(result.senders[0]?.messageCount).toBe(2);
		expect(result.senders[0]?.unreadCount).toBe(1);
		expect(result.senders[0]?.lastReadAt).toBe(20);
		expect(result.senders[1]?.lastReadAt).toBeNull();
	});

	it('ignores mail that already left the Inbox', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 10,
			folderId: seeded.archiveId,
		});

		const result = await t.query(api.mail.subscriptions.list, { mailboxId: seeded.mailboxId });
		expect(result.senders).toEqual([]);
	});

	it("returns an empty panel for another user's mailbox", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t, 'user-A');
		await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 10 });

		sessionMock.userId = 'user-B';
		const result = await t.query(api.mail.subscriptions.list, { mailboxId: seeded.mailboxId });
		expect(result.senders).toEqual([]);
		expect(result.scanned).toBe(0);
	});
});

describe('mail.subscriptions.sendersOfMessages', () => {
	it('collapses a selection to its distinct senders, newest message each', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		const a1 = await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 10 });
		const a2 = await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 20 });
		const b1 = await seedListMessage(t, seeded, { fromAddress: 'deals@b.example', receivedAt: 30 });

		const senders = await t.query(api.mail.subscriptions.sendersOfMessages, {
			mailboxId: seeded.mailboxId,
			messageIds: [a1, a2, b1],
		});
		expect(senders).toEqual([
			{ senderEmail: 'deals@b.example', actionMessageId: b1 },
			{ senderEmail: 'news@a.example', actionMessageId: a2 },
		]);
	});

	it('offers nothing for a selection that only has manual unsubscribe targets', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		const mailtoOnly = await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 10,
			unsubscribe: { mailtoUrl: 'mailto:stop@a.example', oneClick: false },
		});
		const pageOnly = await seedListMessage(t, seeded, {
			fromAddress: 'deals@b.example',
			receivedAt: 20,
			oneClick: false,
		});
		const plain = await seedListMessage(t, seeded, {
			fromAddress: 'friend@c.example',
			receivedAt: 30,
			unsubscribe: { oneClick: false },
		});

		expect(
			await t.query(api.mail.subscriptions.sendersOfMessages, {
				mailboxId: seeded.mailboxId,
				messageIds: [mailtoOnly, pageOnly, plain],
			})
		).toEqual([]);
	});

	it('resolves selected mail that never appears in the panel window', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		const archived = await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 10,
			folderId: seeded.archiveId,
		});

		expect(
			await t.query(api.mail.subscriptions.sendersOfMessages, {
				mailboxId: seeded.mailboxId,
				messageIds: [archived],
			})
		).toEqual([{ senderEmail: 'news@a.example', actionMessageId: archived }]);
	});

	it("returns nothing for another user's mailbox", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t, 'user-A');
		const id = await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 10 });

		sessionMock.userId = 'user-B';
		expect(
			await t.query(api.mail.subscriptions.sendersOfMessages, {
				mailboxId: seeded.mailboxId,
				messageIds: [id],
			})
		).toEqual([]);
	});
});

describe('mail.subscriptions.unsubscribeAndArchive', () => {
	/** One-Click endpoints answer 200; the POST itself is `unsubscribe.ts`'s. */
	function stubOneClickEndpoint() {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);
		return fetchSpy;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('acts on a selected message outside the panel window', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		// Nothing from this sender is in the Inbox, so `list` — the panel's
		// snapshot — knows nothing about them. The selection does.
		const selected = await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 10,
			folderId: seeded.archiveId,
		});
		const fetchSpy = stubOneClickEndpoint();

		const { results } = await t.action(api.mail.subscriptions.unsubscribeAndArchive, {
			mailboxId: seeded.mailboxId,
			senderEmails: ['news@a.example'],
			messageIds: [selected],
		});
		expect(results).toEqual([
			{ senderEmail: 'news@a.example', status: 'unsubscribed', archived: 0 },
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('archives the sender inbox mail behind a selection-driven run', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		const selected = await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 10,
		});
		await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 20 });
		stubOneClickEndpoint();

		const { results } = await t.action(api.mail.subscriptions.unsubscribeAndArchive, {
			mailboxId: seeded.mailboxId,
			senderEmails: ['News@A.example'],
			messageIds: [selected],
		});
		expect(results[0]?.status).toBe('unsubscribed');
		expect(results[0]?.archived).toBe(2);
	});

	it('falls back to the inbox snapshot when no selection is given', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		await seedListMessage(t, seeded, {
			fromAddress: 'news@a.example',
			receivedAt: 10,
			oneClick: false,
		});
		stubOneClickEndpoint();

		const { results } = await t.action(api.mail.subscriptions.unsubscribeAndArchive, {
			mailboxId: seeded.mailboxId,
			senderEmails: ['news@a.example', 'ghost@z.example'],
		});
		expect(results).toEqual([
			{
				senderEmail: 'news@a.example',
				status: 'manual',
				archived: 0,
				httpUrl: 'https://list.example/u',
			},
			{ senderEmail: 'ghost@z.example', status: 'not_found', archived: 0 },
		]);
	});
});

describe('mail.subscriptions.archiveSenderInInbox', () => {
	it("archives only the named sender's inbox mail", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 10 });
		await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 20 });
		const keeper = await seedListMessage(t, seeded, {
			fromAddress: 'deals@b.example',
			receivedAt: 30,
		});

		const result = await t.mutation(api.mail.subscriptions.archiveSenderInInbox, {
			mailboxId: seeded.mailboxId,
			senderEmail: 'News@A.example',
		});
		expect(result.archived).toBe(2);

		const remaining = await t.query(api.mail.subscriptions.list, { mailboxId: seeded.mailboxId });
		expect(remaining.senders.map((s) => s.senderEmail)).toEqual(['deals@b.example']);
		const keeperFolder = await t.run(async (ctx) => (await ctx.db.get(keeper))?.folderId);
		expect(keeperFolder).toBe(seeded.inboxId);
	});

	it('is a no-op when the sender has nothing left in the Inbox', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t);
		const result = await t.mutation(api.mail.subscriptions.archiveSenderInInbox, {
			mailboxId: seeded.mailboxId,
			senderEmail: 'nobody@a.example',
		});
		expect(result.archived).toBe(0);
	});

	it("refuses to archive in another user's mailbox", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailboxWithFolders(t, 'user-A');
		await seedListMessage(t, seeded, { fromAddress: 'news@a.example', receivedAt: 10 });

		sessionMock.userId = 'user-B';
		await expect(
			t.mutation(api.mail.subscriptions.archiveSenderInInbox, {
				mailboxId: seeded.mailboxId,
				senderEmail: 'news@a.example',
			})
		).rejects.toThrow();
	});
});
