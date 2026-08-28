/**
 * Multi-mailbox search (`mail/mailbox/search.ts::search`).
 *
 * The query grew from "one required mailboxId" to "an array, or everything the
 * caller can read", which puts three things at risk that only an end-to-end run
 * can show: that the single-mailbox call is byte-for-byte the old behaviour,
 * that the fan-out merges by `receivedAt` rather than by mailbox, and that the
 * manual keyset walks the union without skipping or repeating a message. The
 * authz edge — a mailbox id the caller cannot read — is asserted here too,
 * because the fan-out re-derives the target set rather than taking the caller's.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

type Ctx = TestConvex<typeof schema>;

/** A mailbox with an inbox folder, owned by `userId`. */
async function seedInbox(t: Ctx, userId: string, address: string): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, { userId, address });
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidNext: 1,
			uidValidity: now,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return mailboxId;
}

/** One message in the mailbox's inbox, with a controlled `receivedAt`. */
async function seedMessage(
	t: Ctx,
	mailboxId: Id<'mailboxes'>,
	subject: string,
	receivedAt: number
): Promise<Id<'mailMessages'>> {
	return await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
			.first();
		if (!folder) throw new Error('inbox folder missing');
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: subject,
			participants: ['someone@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: receivedAt,
			firstMessageAt: receivedAt,
			latestSnippet: subject,
			latestFromAddress: 'someone@example.com',
			latestSubject: subject,
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: receivedAt,
			updatedAt: receivedAt,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		return await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: folder._id,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${subject}@example.com>`,
			threadId,
			fromAddress: 'someone@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject,
			normalizedSubject: subject,
			snippet: subject,
			rawStorageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt,
			internalDate: receivedAt,
			createdAt: receivedAt,
			updatedAt: receivedAt,
		});
	});
}

/** Two mailboxes of user-A with interleaved arrival times. */
async function seedTwoMailboxes(t: Ctx) {
	const personal = await seedInbox(t, 'user-A', 'a@hinterland.camp');
	const team = await seedInbox(t, 'user-A', 'team@hinterland.camp');
	await seedMessage(t, personal, 'oldest', 1_000);
	await seedMessage(t, team, 'middle', 2_000);
	await seedMessage(t, personal, 'newest', 3_000);
	return { personal, team };
}

/** Subjects of a search response, in the order the query returned them. */
function subjects(result: { messages: Array<{ subject: string }> }): string[] {
	return result.messages.map((m) => m.subject);
}

describe('search — single mailbox (legacy shape)', () => {
	it('still searches only the named mailbox', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxId: personal,
			text: '',
		});
		expect(subjects(result)).toEqual(['newest', 'oldest']);
	});

	it('returns empty for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const foreign = await seedInbox(t, 'user-B', 'b@hinterland.camp');
		await seedMessage(t, foreign, 'secret', 5_000);
		const result = await t.query(api.mail.mailbox.search.search, { mailboxId: foreign, text: '' });
		expect(result).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});
});

describe('search — fan-out', () => {
	it('merges every readable mailbox newest-first when none is named', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, { text: '' });
		expect(subjects(result)).toEqual(['newest', 'middle', 'oldest']);
	});

	it('searches exactly the requested mailboxes', async () => {
		const t = convexTest(schema, modules);
		const { team } = await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxIds: [team],
			text: '',
		});
		expect(subjects(result)).toEqual(['middle']);
	});

	it('drops a requested mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await seedTwoMailboxes(t);
		const foreign = await seedInbox(t, 'user-B', 'b@hinterland.camp');
		await seedMessage(t, foreign, 'secret', 9_000);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxIds: [personal, foreign],
			text: '',
		});
		expect(subjects(result)).toEqual(['newest', 'oldest']);
	});

	it('never leaks another user’s mailbox into the "everything readable" default', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const foreign = await seedInbox(t, 'user-B', 'b@hinterland.camp');
		await seedMessage(t, foreign, 'secret', 9_000);
		const result = await t.query(api.mail.mailbox.search.search, { text: '' });
		expect(subjects(result)).not.toContain('secret');
	});

	it('walks the union one row at a time without skipping or repeating', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard += 1) {
			const page: { messages: Array<{ subject: string }>; hasMore: boolean; nextCursor: unknown } =
				await t.query(api.mail.mailbox.search.search, { text: '', limit: 1, cursor });
			seen.push(...subjects(page));
			if (!page.hasMore) break;
			cursor = page.nextCursor as string;
		}
		expect(seen).toEqual(['newest', 'middle', 'oldest']);
	});

	it('keeps making progress when a whole page shares one timestamp', async () => {
		// Same-millisecond arrivals are the case a naive `receivedAt` keyset either
		// loops on forever or steps over; walking them one row at a time must still
		// terminate having seen each exactly once.
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t, 'user-A', 'a@hinterland.camp');
		for (const subject of ['tie-1', 'tie-2', 'tie-3']) {
			await seedMessage(t, mailboxId, subject, 4_000);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 12; guard += 1) {
			const page: { messages: Array<{ subject: string }>; hasMore: boolean; nextCursor: unknown } =
				await t.query(api.mail.mailbox.search.search, { text: '', limit: 1, cursor });
			seen.push(...subjects(page));
			if (!page.hasMore) break;
			cursor = page.nextCursor as string;
		}
		expect(seen.slice().sort()).toEqual(['tie-1', 'tie-2', 'tie-3']);
	});

	it('applies the structured operators per mailbox', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			text: '',
			subject: 'mid',
		});
		expect(subjects(result)).toEqual(['middle']);
	});

	it('merges free-text hits from every mailbox', async () => {
		const t = convexTest(schema, modules);
		const personal = await seedInbox(t, 'user-A', 'a@hinterland.camp');
		const team = await seedInbox(t, 'user-A', 'team@hinterland.camp');
		await seedMessage(t, personal, 'invoice overdue', 1_000);
		await seedMessage(t, team, 'invoice paid', 2_000);
		await seedMessage(t, personal, 'lunch', 3_000);
		const result = await t.query(api.mail.mailbox.search.search, { text: 'invoice' });
		expect(subjects(result)).toEqual(['invoice paid', 'invoice overdue']);
	});

	it('returns nothing for an anonymous caller', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		sessionMock.role = null;
		try {
			const result = await t.query(api.mail.mailbox.search.search, { text: '' });
			expect(result).toEqual({ messages: [], hasMore: false, nextCursor: null });
		} finally {
			sessionMock.role = 'editor';
		}
	});
});
