/**
 * mail.mailbox.queries.listByLabel — the server-side label view.
 *
 * The contract holds in both of its modes: the bounded scan of the newest
 * messages a mailbox keeps until its label rows are backfilled, and the
 * indexed read of `mailLabelMessages` after. These tests pin: exact
 * membership, newest-first order, limit slicing with an honest hasMore, snooze
 * filtering, and no leakage across labels or mailboxes. The last block counts
 * what each mode reads for a sparse label in a large mailbox.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { labelRowsOf, readyLabelRows } from './labelRows.testlib';
import {
	countingDb,
	dependencyDb,
	type DocumentDependencies,
	type SourceReads,
} from './indexRecorder.testlib';
import type { QueryCtx } from '../_generated/server';
import { listByLabel } from '../mail/mailbox/queries';
import { deleteMessageRowAndBlobs } from '../mail/messagePurge';

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

type Fixture = {
	mailboxId: Id<'mailboxes'>;
	labelA: Id<'mailLabels'>;
	labelB: Id<'mailLabels'>;
	labeledIds: Id<'mailMessages'>[];
};

/** One mailbox, two labels, 7 messages of which 3 carry label A. */
async function seed(t: ReturnType<typeof convexTest>): Promise<Fixture> {
	let fixture!: Fixture;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
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
			normalizedSubject: 'labels',
			participants: ['sara@acme.com'],
			messageCount: 7,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'labeled',
			latestFromAddress: 'sara@acme.com',
			latestSubject: 'labels',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const labelA = await ctx.db.insert('mailLabels', {
			mailboxId,
			name: 'work',
			createdAt: now,
		});
		const labelB = await ctx.db.insert('mailLabels', {
			mailboxId,
			name: 'personal',
			createdAt: now,
		});

		const labeledIds: Id<'mailMessages'>[] = [];
		for (let i = 0; i < 7; i++) {
			// Messages 1, 3, 5 (of 0..6) carry label A; message 5 also carries B.
			const labels = i === 5 ? [labelA, labelB] : i % 2 === 1 ? [labelA] : [];
			const storageId = await ctx.storage.store(new Blob([`body-${i}`]));
			const messageId = await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: inboxId,
				uid: i + 1,
				modseq: i + 1,
				rfc822MessageId: `<m${i}@acme.com>`,
				threadId,
				fromAddress: 'sara@acme.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: `message ${i}`,
				normalizedSubject: `message ${i}`,
				snippet: `body ${i}`,
				rawStorageId: storageId,
				rawSize: 6,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: labels,
				receivedAt: now + i * 1000,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
			if (labels.includes(labelA)) labeledIds.push(messageId);
		}
		fixture = { mailboxId, labelA, labelB, labeledIds };
	});
	return fixture;
}

type Prepare = (t: ReturnType<typeof convexTest>, mailboxId: Id<'mailboxes'>) => Promise<void>;

describe.each<{ mode: string; prepare: Prepare }>([
	{ mode: 'scan', prepare: async () => {} },
	{ mode: 'label rows', prepare: readyLabelRows },
])('mail.mailbox.queries.listByLabel ($mode)', ({ prepare }) => {
	async function seedFor(t: ReturnType<typeof convexTest>): Promise<Fixture> {
		const fixture = await seed(t);
		await prepare(t, fixture.mailboxId);
		return fixture;
	}

	it('returns exactly the messages carrying the label, newest first', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelA, labeledIds } = await seedFor(t);

		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
		});
		expect(result.messages.map((m) => m._id)).toEqual([...labeledIds].reverse());
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeNull();
	});

	it('slices by limit and reports hasMore honestly', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelA, labeledIds } = await seedFor(t);

		const page = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
			limit: 2,
		});
		expect(page.messages.map((m) => m._id)).toEqual([...labeledIds].reverse().slice(0, 2));
		expect(page.hasMore).toBe(true);
	});

	it("does not leak another label's messages through a shared message", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelB } = await seedFor(t);
		// Message 5 carries both A and B; querying B returns only that one.
		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelB,
		});
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.subject).toBe('message 5');
	});

	it('hides still-snoozed rows like every other folder view', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelA } = await seedFor(t);
		await t.run(async (ctx) => {
			// Snooze the newest labeled message ("message 5").
			const scanned = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.order('desc')
				.take(50);
			const target = scanned.find((m) => m.subject === 'message 5')!;
			await ctx.db.patch(target._id, { snoozedUntil: Date.now() + 60_000 });
		});
		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
		});
		expect(result.messages.map((m) => m.subject)).toEqual(['message 3', 'message 1']);
	});

	it('snoozed rows do not eat result slots or inflate hasMore', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelA } = await seedFor(t);
		await t.run(async (ctx) => {
			const scanned = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.order('desc')
				.take(50);
			const target = scanned.find((m) => m.subject === 'message 5')!;
			await ctx.db.patch(target._id, { snoozedUntil: Date.now() + 60_000 });
		});

		// Three rows carry label A; the newest is snoozed. Asking for 2 must
		// return the two VISIBLE rows — slicing before the snooze filter handed
		// back a short page (one row) with matches still inside the window.
		const page = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
			limit: 2,
		});
		expect(page.messages.map((m) => m.subject)).toEqual(['message 3', 'message 1']);
		// Two visible matches, two returned: nothing is being withheld, so the
		// cap note must not claim otherwise (the pre-filter count said it was).
		expect(page.hasMore).toBe(false);
	});
});

describe('mail.mailbox.queries.listByLabel before the label rows are backfilled', () => {
	it('rows older than the scan window are out of reach, the fallback edge', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelA } = await seed(t);
		// Push the mailbox past LABEL_SCAN_WINDOW (1000): 993 unlabeled fillers
		// newer than the fixture's 7 rows, then one LABELED row older than all
		// of them — position 1002, outside the window (while the fixture's
		// labeled rows sit at positions ≤ 1000, inside it).
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
			for (let i = 7; i < 1000; i++) {
				const storageId = await ctx.storage.store(new Blob([`filler-${i}`]));
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId: inboxId,
					uid: i + 1,
					modseq: i + 1,
					rfc822MessageId: `<filler${i}@acme.com>`,
					threadId,
					fromAddress: 'sara@acme.com',
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `filler ${i}`,
					normalizedSubject: `filler ${i}`,
					snippet: `body ${i}`,
					rawStorageId: storageId,
					rawSize: 8,
					attachments: [],
					hasAttachments: false,
					flagSeen: true,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now + i * 1000,
					internalDate: now,
					createdAt: now,
					updatedAt: now,
				});
			}
			const deepStorageId = await ctx.storage.store(new Blob(['deep']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: inboxId,
				uid: 2000,
				modseq: 2000,
				rfc822MessageId: '<deep@acme.com>',
				threadId,
				fromAddress: 'sara@acme.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'deep labeled',
				normalizedSubject: 'deep labeled',
				snippet: 'deep body',
				rawStorageId: deepStorageId,
				rawSize: 9,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [labelA],
				receivedAt: now - 10_000,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		const result = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId: labelA,
		});
		// The three windowed labeled rows are served newest-first; the labeled
		// row beyond the scan window is invisible: LABEL_SCAN_WINDOW is the
		// fallback's total reach until the mailbox's label rows are ready.
		expect(result.messages.map((m) => m.subject)).toEqual(['message 5', 'message 3', 'message 1']);
		expect(result.hasMore).toBe(false);
	});
});

type LabelPage = {
	messages: Array<{ _id: Id<'mailMessages'>; subject: string; receivedAt: number }>;
	hasMore: boolean;
	nextCursor: string | null;
};
const listByLabelHandler = listByLabel as unknown as {
	_handler: (
		ctx: QueryCtx,
		args: { mailboxId: Id<'mailboxes'>; labelId: Id<'mailLabels'>; limit?: number; cursor?: string }
	) => Promise<LabelPage>;
};

type History = {
	mailboxId: Id<'mailboxes'>;
	labelId: Id<'mailLabels'>;
	/** The label's messages, oldest first. */
	matchIds: Id<'mailMessages'>[];
	unrelatedIds: Set<string>;
};

/**
 * `unrelated` unlabeled messages, all newer than the label's `matches`, which
 * sit below the newest 1,000 (the fallback's scan window).
 */
async function seedHistory(
	t: ReturnType<typeof convexTest>,
	{ unrelated, matches }: { unrelated: number; matches: number }
): Promise<History> {
	const seeded = await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
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
		const folderId = await ctx.db.insert('mailFolders', {
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
		const labelId = await ctx.db.insert('mailLabels', { mailboxId, name: 'rare', createdAt: now });
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'history',
			participants: ['sara@acme.com'],
			messageCount: unrelated + matches,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'history',
			latestFromAddress: 'sara@acme.com',
			latestSubject: 'history',
			folderRoles: ['inbox'],
			labelIds: [labelId],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const insert = (i: number, labelIds: Id<'mailLabels'>[], subject: string) =>
			ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: i + 1,
				modseq: 1,
				rfc822MessageId: `<${subject}@acme.com>`,
				threadId,
				fromAddress: 'sara@acme.com',
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
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds,
				receivedAt: now + i * 1000,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
		const matchIds: Id<'mailMessages'>[] = [];
		for (let i = 0; i < matches; i++) matchIds.push(await insert(i, [labelId], `match ${i}`));
		const unrelatedIds: string[] = [];
		for (let i = matches; i < matches + unrelated; i++) {
			unrelatedIds.push(await insert(i, [], `other ${i}`));
		}
		return { mailboxId, labelId, matchIds, unrelatedIds };
	});
	return { ...seeded, unrelatedIds: new Set(seeded.unrelatedIds) };
}

async function countedPage(
	t: ReturnType<typeof convexTest>,
	args: { mailboxId: Id<'mailboxes'>; labelId: Id<'mailLabels'>; limit?: number }
): Promise<{ page: LabelPage; reads: SourceReads }> {
	const reads: SourceReads = new Map();
	const page = await t.run((ctx) =>
		listByLabelHandler._handler({ ...ctx, db: countingDb(ctx.db, reads) } as QueryCtx, args)
	);
	return { page, reads };
}

function messageReads(reads: SourceReads): number {
	let total = 0;
	for (const [source, count] of reads) if (source.startsWith('mailMessages:')) total += count;
	return total;
}

describe('mail.mailbox.queries.listByLabel reads for a sparse label', () => {
	it('reads the label rows, not the newest 1,000 messages, and reaches the old match', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelId, matchIds } = await seedHistory(t, {
			unrelated: 10_000,
			matches: 1,
		});

		// Before the backfill: the scan reads the newest 1,000 messages and the
		// one match, older than all of them, is out of reach.
		const scan = await countedPage(t, { mailboxId, labelId, limit: 50 });
		expect(messageReads(scan.reads)).toBe(1000);
		expect(scan.page.messages).toEqual([]);

		await readyLabelRows(t, mailboxId);
		const indexed = await countedPage(t, { mailboxId, labelId, limit: 50 });
		expect(indexed.page.messages.map((m) => m._id)).toEqual(matchIds);
		expect(indexed.page.hasMore).toBe(false);
		expect(indexed.page.nextCursor).toBeNull();
		// One label row, one message fetched by id, no message range read.
		expect(indexed.reads.get('mailLabelMessages:by_mailbox_and_label_and_received')).toBe(1);
		expect(messageReads(indexed.reads)).toBe(0);
	});

	it('leaves every unrelated message out of the read set', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelId, unrelatedIds } = await seedHistory(t, {
			unrelated: 1200,
			matches: 3,
		});
		await readyLabelRows(t, mailboxId);
		const deps: DocumentDependencies = { read: new Set(), written: new Set() };
		const page = await t.run((ctx) =>
			listByLabelHandler._handler({ ...ctx, db: dependencyDb(ctx.db, deps) } as QueryCtx, {
				mailboxId,
				labelId,
			})
		);
		expect(page.messages).toHaveLength(3);
		expect([...deps.read].filter((id) => unrelatedIds.has(id))).toEqual([]);
	});

	it('pages to the end newest first, with no row twice and snoozed rows hidden', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelId, matchIds } = await seedHistory(t, { unrelated: 20, matches: 9 });
		const snoozed = matchIds[4]!;
		await t.run(async (ctx) => {
			await ctx.db.patch(snoozed, { snoozedUntil: Date.now() + 60_000 });
			// Two matches arriving in the same millisecond must both be served.
			const tied = (await ctx.db.get(matchIds[6]!))!;
			await ctx.db.patch(matchIds[7]!, { receivedAt: tied.receivedAt });
		});
		await readyLabelRows(t, mailboxId);

		const served: Array<{ _id: Id<'mailMessages'>; receivedAt: number }> = [];
		let cursor: string | undefined;
		for (let pages = 1; ; pages += 1) {
			expect(pages).toBeLessThanOrEqual(matchIds.length);
			const page = await t.query(api.mail.mailbox.queries.listByLabel, {
				mailboxId,
				labelId,
				limit: 2,
				...(cursor ? { cursor } : {}),
			});
			served.push(...page.messages);
			if (!page.hasMore) {
				expect(page.nextCursor).toBeNull();
				break;
			}
			cursor = page.nextCursor!;
		}
		const ids = served.map((m) => m._id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(ids)).toEqual(new Set(matchIds.filter((id) => id !== snoozed)));
		const times = served.map((m) => m.receivedAt);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it('drops the rows of a deleted message, and the view stops listing it', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, labelId, matchIds } = await seedHistory(t, { unrelated: 5, matches: 2 });
		await readyLabelRows(t, mailboxId);
		const [gone, kept] = matchIds as [Id<'mailMessages'>, Id<'mailMessages'>];
		expect(await labelRowsOf(t, gone)).toHaveLength(1);

		await t.run(async (ctx) => deleteMessageRowAndBlobs(ctx, (await ctx.db.get(gone))!));

		expect(await labelRowsOf(t, gone)).toEqual([]);
		const page = await t.query(api.mail.mailbox.queries.listByLabel, { mailboxId, labelId });
		expect(page.messages.map((m) => m._id)).toEqual([kept]);
	});
});
