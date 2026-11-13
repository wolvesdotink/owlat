/**
 * Operator-only Postbox search reads the narrowest index the clause allows
 * (`mail/mailbox/search.ts`).
 *
 * A text-free clause is verified in JS row by row, so the result set is the
 * same whichever index feeds it; what changes is how many rows are read to
 * produce it. These tests count the `mailMessages` rows each source returns
 * BEFORE the post-filter (`countingDb`), walk every page to the end, and pin
 * both the count and the exact result, including a tie group of identical
 * timestamps walked one row per page.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { searchMailbox, searchMailboxes } from '../mailbox/search';
import { normalizeClause, type SearchClause } from '../mailbox/searchClause';
import { countingDb, type SourceReads } from '../../__tests__/indexRecorder.testlib';
import { modules } from './helpers.testlib';

type Ctx = TestConvex<typeof schema>;

/** Inbox history that a narrowed source must not visit. */
const HISTORY = 2_000;
/** The rows the narrowed clause actually matches. */
const MATCHES = 10;

type FolderRole = 'inbox' | 'sent';

interface SeededMailbox {
	mailboxId: Id<'mailboxes'>;
	folders: Record<FolderRole, Id<'mailFolders'>>;
}

async function seedMailbox(t: Ctx, address: string): Promise<SeededMailbox> {
	return await t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address,
			domain: 'owlat.test',
			status: 'active',
			usedBytes: 0,
			uidValidity: 1,
			createdAt: 1,
			updatedAt: 1,
		});
		const folder = (role: FolderRole) =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name: role.toUpperCase(),
				role,
				uidValidity: 1,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: 1,
				updatedAt: 1,
			});
		return { mailboxId, folders: { inbox: await folder('inbox'), sent: await folder('sent') } };
	});
}

/** Insert `rows` messages in one transaction; one shared thread and blob keep it cheap. */
async function seedMessages(
	t: Ctx,
	box: SeededMailbox,
	rows: ReadonlyArray<{ role: FolderRole; receivedAt: number; subject: string }>
): Promise<Id<'mailMessages'>[]> {
	return await t.run(async (ctx) => {
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: box.mailboxId,
			normalizedSubject: 'fixture',
			participants: [],
			messageCount: rows.length,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: 1,
			firstMessageAt: 1,
			latestSnippet: '',
			latestFromAddress: 'someone@owlat.test',
			latestSubject: 'fixture',
			folderRoles: ['inbox', 'sent'],
			labelIds: [],
			createdAt: 1,
			updatedAt: 1,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const ids: Id<'mailMessages'>[] = [];
		for (const [index, row] of rows.entries()) {
			ids.push(
				await ctx.db.insert('mailMessages', {
					mailboxId: box.mailboxId,
					folderId: box.folders[row.role],
					uid: index + 1,
					modseq: 1,
					rfc822MessageId: `<${row.subject}@owlat.test>`,
					threadId,
					fromAddress: 'someone@owlat.test',
					toAddresses: ['me@owlat.test'],
					ccAddresses: [],
					bccAddresses: [],
					subject: row.subject,
					normalizedSubject: row.subject,
					snippet: row.subject,
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
					receivedAt: row.receivedAt,
					internalDate: row.receivedAt,
					createdAt: row.receivedAt,
					updatedAt: row.receivedAt,
				})
			);
		}
		return ids;
	});
}

function clause(fields: Partial<SearchClause>): SearchClause[] {
	return [normalizeClause({ text: '', ...fields })];
}

interface Walk {
	subjects: string[];
	/** `mailMessages` rows returned by each index source, summed over every page. */
	reads: SourceReads;
	pages: number;
}

/** Every `mailMessages` row the walk's sources returned, before filtering. */
function messageReads(walk: Walk): number {
	let total = 0;
	for (const [source, count] of walk.reads) if (source.startsWith('mailMessages:')) total += count;
	return total;
}

/**
 * Walk a search to its end, one transaction per page as the client would,
 * failing on a repeated row or a walk that does not terminate.
 */
async function walk(
	t: Ctx,
	page: (
		ctx: QueryCtx,
		cursor: string | undefined
	) => Promise<{ messages: Doc<'mailMessages'>[]; nextCursor: string | null }>,
	startCursor?: string
): Promise<Walk> {
	const reads: SourceReads = new Map();
	const subjects: string[] = [];
	const seen = new Set<string>();
	let cursor = startCursor;
	let pages = 0;
	for (;;) {
		pages += 1;
		if (pages > 2 * HISTORY) throw new Error('walk did not terminate');
		const result = await t.run(async (ctx) =>
			page({ ...ctx, db: countingDb(ctx.db, reads) } as unknown as QueryCtx, cursor)
		);
		for (const message of result.messages) {
			if (seen.has(message._id)) throw new Error(`row repeated: ${message.subject}`);
			seen.add(message._id);
			subjects.push(message.subject);
		}
		if (!result.nextCursor) return { subjects, reads, pages };
		cursor = result.nextCursor;
	}
}

/** `HISTORY` Inbox rows interleaved with `MATCHES` Sent rows; Sent rows are `sent-<n>`. */
function interleavedHistory(): Array<{ role: FolderRole; receivedAt: number; subject: string }> {
	const rows: Array<{ role: FolderRole; receivedAt: number; subject: string }> = [];
	for (let i = 0; i < HISTORY; i += 1) {
		rows.push({ role: 'inbox', receivedAt: 1_000_000 + i * 10, subject: `inbox-${i}` });
	}
	for (let n = 0; n < MATCHES; n += 1) {
		rows.push({ role: 'sent', receivedAt: sentAt(n), subject: `sent-${n}` });
	}
	return rows;
}

/** Arrival time of `sent-<n>`, spread evenly through the Inbox history. */
function sentAt(n: number): number {
	return 1_000_005 + n * Math.floor(HISTORY / MATCHES) * 10;
}

const newestSentFirst = Array.from({ length: MATCHES }, (_, n) => `sent-${MATCHES - 1 - n}`);

describe('operator-only search — `in:` reads the folder, not the mailbox', () => {
	it('single mailbox: walking `in:sent` reads the Sent rows only', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, interleavedHistory());

		const result = await walk(t, (ctx, cursor) =>
			searchMailbox(ctx, box.mailboxId, clause({ folderRole: 'sent' }), 4, cursor)
		);

		expect(result.subjects).toEqual(newestSentFirst);
		expect(messageReads(result)).toBe(MATCHES);
		expect(result.reads.get('mailMessages:by_mailbox_and_received') ?? 0).toBe(0);
	});

	it('fan-out: walking `in:sent` reads each mailbox’s Sent rows only', async () => {
		const t = convexTest(schema, modules);
		const big = await seedMailbox(t, 'me@owlat.test');
		const small = await seedMailbox(t, 'team@owlat.test');
		await seedMessages(t, big, interleavedHistory());
		await seedMessages(t, small, [
			{ role: 'sent', receivedAt: sentAt(4) + 1, subject: 'team-sent-new' },
			{ role: 'inbox', receivedAt: sentAt(4) + 2, subject: 'team-inbox' },
			{ role: 'sent', receivedAt: sentAt(0) - 4, subject: 'team-sent-old' },
		]);

		const result = await walk(t, (ctx, cursor) =>
			searchMailboxes(
				ctx,
				[big.mailboxId, small.mailboxId],
				clause({ folderRole: 'sent' }),
				4,
				cursor
			)
		);

		const expected = [...newestSentFirst];
		// team-sent-new sits between sent-5 and sent-4; team-sent-old is the oldest.
		expected.splice(expected.indexOf('sent-4'), 0, 'team-sent-new');
		expected.push('team-sent-old');
		// Each page re-reads a mailbox's boundary row (the `<=` resume bound) and
		// a cut-off row it already read, so reads exceed the match count by at
		// most a few rows per page, never by the Inbox history.
		expect(messageReads(result)).toBeLessThanOrEqual((MATCHES + 2) * 2);
		expect(result.reads.get('mailMessages:by_mailbox_and_received') ?? 0).toBe(0);
		expect(result.subjects).toEqual(expected);
	});

	it('walks a tie group of identical timestamps one row per page without loss', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		const rows: Array<{ role: FolderRole; receivedAt: number; subject: string }> = [];
		for (let i = 0; i < 6; i += 1) {
			rows.push({ role: 'sent', receivedAt: 5_000, subject: `tie-${i}` });
			rows.push({ role: 'inbox', receivedAt: 5_000, subject: `noise-${i}` });
		}
		rows.push({ role: 'sent', receivedAt: 4_000, subject: 'older' });
		await seedMessages(t, box, rows);
		const ties = ['tie-0', 'tie-1', 'tie-2', 'tie-3', 'tie-4', 'tie-5'];

		const single = await walk(t, (ctx, cursor) =>
			searchMailbox(ctx, box.mailboxId, clause({ folderRole: 'sent' }), 1, cursor)
		);
		expect(single.subjects.slice(0, 6).sort()).toEqual(ties);
		expect(single.subjects[6]).toBe('older');
		expect(single.subjects).toHaveLength(7);

		const fanOut = await walk(t, (ctx, cursor) =>
			searchMailboxes(ctx, [box.mailboxId], clause({ folderRole: 'sent' }), 1, cursor)
		);
		expect(fanOut.subjects.slice(0, 6).sort()).toEqual(ties);
		expect(fanOut.subjects[6]).toBe('older');
		expect(fanOut.subjects).toHaveLength(7);
		expect(fanOut.reads.get('mailMessages:by_mailbox_and_received') ?? 0).toBe(0);
	});
});

describe('operator-only search — before:/after: bound the arrival range', () => {
	/** `MATCHES` rows inside (2_000, 3_000), a few older ones, `HISTORY` newer ones. */
	function datedHistory(): Array<{ role: FolderRole; receivedAt: number; subject: string }> {
		const rows: Array<{ role: FolderRole; receivedAt: number; subject: string }> = [];
		for (let i = 0; i < HISTORY; i += 1) {
			rows.push({ role: 'inbox', receivedAt: 10_000 + i, subject: `newer-${i}` });
		}
		for (let n = 0; n < MATCHES; n += 1) {
			rows.push({ role: 'inbox', receivedAt: 2_100 + n * 50, subject: `match-${n}` });
		}
		rows.push({ role: 'inbox', receivedAt: 3_000, subject: 'at-before-bound' });
		rows.push({ role: 'inbox', receivedAt: 2_000, subject: 'at-after-bound' });
		rows.push({ role: 'inbox', receivedAt: 1_000, subject: 'older' });
		return rows;
	}
	const newestMatchFirst = Array.from({ length: MATCHES }, (_, n) => `match-${MATCHES - 1 - n}`);
	const bounds = { afterMs: 2_000, beforeMs: 3_000 };

	it('single mailbox: unrelated newer mail is not visited', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, datedHistory());

		const result = await walk(t, (ctx, cursor) =>
			searchMailbox(ctx, box.mailboxId, clause(bounds), 4, cursor)
		);

		expect(result.subjects).toEqual(newestMatchFirst);
		expect(messageReads(result)).toBe(MATCHES);
	});

	it('fan-out: unrelated newer mail is not visited', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, datedHistory());

		const result = await walk(t, (ctx, cursor) =>
			searchMailboxes(ctx, [box.mailboxId], clause(bounds), 4, cursor)
		);

		expect(result.subjects).toEqual(newestMatchFirst);
		expect(messageReads(result)).toBeLessThanOrEqual(MATCHES + 4);
	});

	it('combines `in:` with the bounds on the folder index', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, [
			...datedHistory(),
			{ role: 'sent', receivedAt: 2_500, subject: 'sent-in-range' },
			{ role: 'sent', receivedAt: 20_000, subject: 'sent-newer' },
		]);

		const result = await walk(t, (ctx, cursor) =>
			searchMailbox(ctx, box.mailboxId, clause({ ...bounds, folderRole: 'sent' }), 4, cursor)
		);

		expect(result.subjects).toEqual(['sent-in-range']);
		expect(messageReads(result)).toBe(1);
	});
});

describe('operator-only search — a cursor resumes only its own source', () => {
	it('a cursor minted for `in:sent` does not resume a mailbox-wide search', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, [
			{ role: 'sent', receivedAt: 3_000, subject: 'sent-new' },
			{ role: 'inbox', receivedAt: 2_500, subject: 'inbox-mid' },
			{ role: 'sent', receivedAt: 2_000, subject: 'sent-old' },
		]);
		const first = await t.run((ctx) =>
			searchMailbox(ctx, box.mailboxId, clause({ folderRole: 'sent' }), 1, undefined)
		);
		expect(first.messages.map((m) => m.subject)).toEqual(['sent-new']);
		expect(first.nextCursor).not.toBeNull();

		const foreign = await t.run((ctx) =>
			searchMailbox(ctx, box.mailboxId, clause({}), 10, first.nextCursor!)
		);
		expect(foreign).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});

	it('a mailbox-arrival cursor from before the narrowing still resumes where it stopped', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, interleavedHistory());
		// Page one as the previous release served `in:sent`: the arrival index,
		// natively paginated, post-filtered to Sent.
		const legacy = await t.run((ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', box.mailboxId))
				.order('desc')
				.paginate({ cursor: null, numItems: 400 })
		);
		const firstPage = legacy.page
			.filter((m) => m.folderId === box.folders.sent)
			.map((m) => m.subject);

		const rest = await walk(
			t,
			(ctx, cursor) =>
				searchMailbox(ctx, box.mailboxId, clause({ folderRole: 'sent' }), 100, cursor),
			legacy.continueCursor
		);

		expect([...firstPage, ...rest.subjects]).toEqual(newestSentFirst);
	});

	it('a fan-out position minted on the folder does not resume a mailbox-wide walk', async () => {
		const t = convexTest(schema, modules);
		const box = await seedMailbox(t, 'me@owlat.test');
		await seedMessages(t, box, [
			{ role: 'sent', receivedAt: 3_000, subject: 'sent-new' },
			{ role: 'inbox', receivedAt: 2_500, subject: 'inbox-mid' },
			{ role: 'sent', receivedAt: 2_000, subject: 'sent-old' },
		]);
		const first = await t.run((ctx) =>
			searchMailboxes(ctx, [box.mailboxId], clause({ folderRole: 'sent' }), 1, undefined)
		);
		expect(first.messages.map((m) => m.subject)).toEqual(['sent-new']);

		const foreign = await t.run((ctx) =>
			searchMailboxes(ctx, [box.mailboxId], clause({}), 10, first.nextCursor!)
		);
		expect(foreign).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});
});
