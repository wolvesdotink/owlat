/**
 * Mailbox search — operator + free-text coverage.
 *
 * Regression guard for the bug where a free-text term combined with a partial
 * `from:` operator returned zero results: the text branch applied an exact
 * `.eq('fromAddress', token)` on the search index (a substring like "sara"
 * never equals "sara@acme.com"), while the no-text branch used the substring
 * post-filter and worked. Both branches must now honour a partial from-token.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

async function seed(t: ReturnType<typeof convexTest>) {
	let mailboxId!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'project meeting',
			participants: ['sara@acme.com'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'meeting notes',
			latestFromAddress: 'sara@acme.com',
			latestSubject: 'project meeting',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const storageId = await ctx.storage.store(new Blob(['meeting']));
		await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m1@acme.com>',
			threadId,
			fromAddress: 'sara@acme.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'project meeting',
			normalizedSubject: 'project meeting',
			snippet: 'meeting notes about the launch',
			rawStorageId: storageId,
			rawSize: 7,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId };
}

describe('mail.mailbox.search.search', () => {
	it('matches free text combined with a partial from-token', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting',
			from: 'sara',
		});
		expect(results.messages.map((m) => m.subject)).toEqual(['project meeting']);
		expect(results.hasMore).toBe(false);
		expect(results.nextCursor).toBeNull();
	});

	it('matches a partial from-token with no free text', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: '',
			from: 'sara',
		});
		expect(results.messages.map((m) => m.subject)).toEqual(['project meeting']);
	});

	it('excludes a non-matching from-token', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting',
			from: 'bob',
		});
		expect(results.messages).toEqual([]);
	});

	it('requires a quoted phrase to appear verbatim, not as loose tokens', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);

		// The seeded row's snippet is "meeting notes about the launch": both words
		// are present, so the token index matches either ordering. Only the
		// adjacent one is a phrase hit.
		const adjacent = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting notes',
			phrases: ['meeting notes'],
		});
		expect(adjacent.messages.map((m) => m.subject)).toEqual(['project meeting']);

		const reversed = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting notes',
			phrases: ['notes meeting'],
		});
		expect(reversed.messages).toEqual([]);
	});

	it('matches a phrase across the subject as well as the snippet', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'project meeting',
			phrases: ['project meeting'],
		});
		expect(results.messages.map((m) => m.subject)).toEqual(['project meeting']);
	});

	it('requires EVERY phrase when more than one is quoted', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting',
			phrases: ['meeting notes', 'no such phrase'],
		});
		expect(results.messages).toEqual([]);
	});

	it('paginates: the cursor continues where the first page stopped', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		// Seed two more matches so the first page (limit 1) can't hold them all.
		await t.run(async (ctx) => {
			const now = Date.now();
			const inboxId = (await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
				.first())!._id;
			const threadId = (await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
				.first())!._id;
			for (const [i, subject] of ['second meeting', 'third meeting'].entries()) {
				const storageId = await ctx.storage.store(new Blob([subject]));
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId: inboxId,
					uid: i + 2,
					modseq: i + 2,
					rfc822MessageId: `<m${i + 2}@acme.com>`,
					threadId,
					fromAddress: 'sara@acme.com',
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject,
					normalizedSubject: subject,
					snippet: `${subject} notes`,
					rawStorageId: storageId,
					rawSize: 7,
					attachments: [],
					hasAttachments: false,
					flagSeen: false,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now + (i + 1) * 1000,
					internalDate: now,
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const page1 = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting',
			limit: 1,
		});
		expect(page1.messages).toHaveLength(1);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'meeting',
			limit: 1,
			cursor: page1.nextCursor!,
		});
		expect(page2.messages).toHaveLength(1);
		// No overlap and no repeat between pages.
		expect(page2.messages[0]!._id).not.toBe(page1.messages[0]!._id);
	});

	it('a post-filter that zeroes a page never skips or repeats later matches', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		// Two bob messages newer than the seeded sara one, plus a second sara
		// message between them: at limit 2 the FIRST page is entirely
		// post-filtered away by `from: sara` — its cursor must carry the scan
		// position (rows consumed, not skipped) so page two still sees both
		// sara rows exactly once.
		await t.run(async (ctx) => {
			const now = Date.now();
			const inboxId = (await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
				.first())!._id;
			const threadId = (await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
				.first())!._id;
			const inserts: Array<{ from: string; at: number; subject: string }> = [
				{ from: 'bob@acme.com', at: now + 3000, subject: 'bob meeting one' },
				{ from: 'sara@acme.com', at: now + 1000, subject: 'second meeting' },
				{ from: 'bob@acme.com', at: now + 2000, subject: 'bob meeting two' },
			];
			for (const [i, insert] of inserts.entries()) {
				const storageId = await ctx.storage.store(new Blob([insert.subject]));
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId: inboxId,
					uid: i + 2,
					modseq: i + 2,
					rfc822MessageId: `<m${i + 2}@acme.com>`,
					threadId,
					fromAddress: insert.from,
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject: insert.subject,
					normalizedSubject: insert.subject,
					snippet: `${insert.subject} notes`,
					rawStorageId: storageId,
					rawSize: 7,
					attachments: [],
					hasAttachments: false,
					flagSeen: false,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: insert.at,
					internalDate: now,
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const collected: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 5; page++) {
			const result = await t.query(api.mail.mailbox.search.search, {
				mailboxId,
				text: 'meeting',
				from: 'sara',
				limit: 2,
				...(cursor ? { cursor } : {}),
			});
			collected.push(...result.messages.map((m) => m.subject));
			if (!result.nextCursor) break;
			cursor = result.nextCursor;
		}
		// Both sara rows collected exactly once: the zeroed first page handed
		// its scan position on. (Text-branch order is relevance, not time —
		// compare as a set.)
		expect([...collected].sort()).toEqual(['project meeting', 'second meeting']);
	});
});
