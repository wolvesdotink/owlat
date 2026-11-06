/**
 * Whole-folder "Mark all as read" (also for a label and for a smart-inbox
 * category) and "Empty Trash / Spam".
 *
 * The properties that matter are the edges of "all": every unread message up
 * to the moment of the click, across as many batches as it takes, and nothing
 * that arrived afterwards, nothing snoozed, nothing in another folder, label or
 * category. Emptying is limited to Trash and Spam and, on a team inbox, to its
 * owners.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import {
	modules,
	seedMailbox,
	seedFolder,
	seedMessage,
	type SeededFolderRole,
} from './helpers.testlib';
import { MARK_FOLDER_READ_BATCH, EMPTY_FOLDER_BATCH, markLabelRead } from '../folderBulk';
import { withCreationTime } from '../../__tests__/helpers/creationTimeSeam';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: sessionMocks.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * Seed `count` messages into the mailbox's `role` folder with distinct uids
 * and the folder counters a real delivery leaves behind.
 */
async function seedMessages(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: SeededFolderRole,
	count: number,
	seed: { flagSeen?: boolean; subjectPrefix?: string } = {}
): Promise<Id<'mailMessages'>[]> {
	const ids: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i++) {
		ids.push(
			await seedMessage(t, mailboxId, {
				role,
				subject: `${seed.subjectPrefix ?? role}-${i}`,
				flagSeen: seed.flagSeen ?? false,
			})
		);
	}
	await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		if (!folder) throw new Error(`folder ${role} missing`);
		let uid = folder.uidNext;
		for (const id of ids) {
			const message = await ctx.db.get(id);
			await ctx.db.patch(id, { uid: uid++ });
			if (message?.flagSeen) {
				await ctx.db.patch(message.threadId, { unreadCount: 0 });
			}
		}
		await ctx.db.patch(folder._id, {
			uidNext: uid,
			totalCount: folder.totalCount + ids.length,
			unseenCount: folder.unseenCount + (seed.flagSeen ? 0 : ids.length),
		});
	});
	return ids;
}

async function folderOf(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: SeededFolderRole
) {
	return await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		if (!folder) throw new Error(`folder ${role} missing`);
		return folder;
	});
}

async function unreadIds(
	t: TestConvex<typeof schema>,
	folderId: Id<'mailFolders'>
): Promise<Id<'mailMessages'>[]> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_seen', (q) => q.eq('folderId', folderId).eq('flagSeen', false))
			.collect();
		return rows.map((row) => row._id);
	});
}

async function countIn(t: TestConvex<typeof schema>, folderId: Id<'mailFolders'>): Promise<number> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
			.collect();
		return rows.length;
	});
}

/** Drive `markFolderRead` the way the client does, returning every id it flipped. */
async function markAllRead(
	t: TestConvex<typeof schema>,
	folderId: Id<'mailFolders'>,
	betweenBatches?: () => Promise<void>
): Promise<{ markedIds: Id<'mailMessages'>[]; calls: number }> {
	const markedIds: Id<'mailMessages'>[] = [];
	let cursor: { ceilingUid: number; afterUid: number } | null = null;
	let calls = 0;
	for (;;) {
		const answer: { markedIds: Id<'mailMessages'>[]; ceilingUid: number; afterUid: number | null } =
			await t.mutation(api.mail.folderBulk.markFolderRead, { folderId, ...cursor });
		calls++;
		markedIds.push(...answer.markedIds);
		if (answer.afterUid === null) break;
		cursor = { ceilingUid: answer.ceilingUid, afterUid: answer.afterUid };
		await betweenBatches?.();
	}
	return { markedIds, calls };
}

async function seedLabel(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	name: string
): Promise<Id<'mailLabels'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('mailLabels', { mailboxId, name, createdAt: Date.now() })
	);
}

async function setLabels(
	t: TestConvex<typeof schema>,
	ids: readonly Id<'mailMessages'>[],
	labelIds: Id<'mailLabels'>[]
): Promise<void> {
	await t.run(async (ctx) => {
		for (const id of ids) await ctx.db.patch(id, { labelIds });
	});
}

async function setCategory(
	t: TestConvex<typeof schema>,
	ids: readonly Id<'mailMessages'>[],
	label: 'newsletter' | 'person'
): Promise<void> {
	await t.run(async (ctx) => {
		for (const id of ids) {
			const message = await ctx.db.get(id);
			if (!message) throw new Error('message missing');
			await ctx.db.patch(message.threadId, {
				category: { label, source: 'heuristic', classifiedAt: Date.now() },
			});
		}
	});
}

async function unreadOf(
	t: TestConvex<typeof schema>,
	ids: readonly Id<'mailMessages'>[]
): Promise<Id<'mailMessages'>[]> {
	return await t.run(async (ctx) => {
		const unread: Id<'mailMessages'>[] = [];
		for (const id of ids) {
			const message = await ctx.db.get(id);
			if (message && !message.flagSeen) unread.push(id);
		}
		return unread;
	});
}

type LabelAnswer = {
	markedIds: Id<'mailMessages'>[];
	ceilingTime: number;
	cursor: string | null;
};

/** Drive `markLabelRead` the way the client does, keeping each batch's ids. */
async function markLabelAllRead(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	labelId: Id<'mailLabels'>,
	betweenBatches?: () => Promise<void>
): Promise<{ batches: Id<'mailMessages'>[][] }> {
	const batches: Id<'mailMessages'>[][] = [];
	let next: { ceilingTime: number; cursor: string } | null = null;
	for (;;) {
		const answer: LabelAnswer = await t.mutation(api.mail.folderBulk.markLabelRead, {
			mailboxId,
			labelId,
			...next,
		});
		batches.push(answer.markedIds);
		if (answer.cursor === null) break;
		next = { ceilingTime: answer.ceilingTime, cursor: answer.cursor };
		await betweenBatches?.();
	}
	return { batches };
}

/**
 * `db` that counts every row a `mailMessages` read over `by_mailbox_and_unseen`
 * hands back: the walk `markLabelRead` pages through. Reads the flag writes
 * make per message go through other indexes and are not counted.
 */
function unseenWalkCountingDb(db: MutationCtx['db'], counter: { rows: number }): MutationCtx['db'] {
	const counted = (query: object): object =>
		new Proxy(query, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (typeof value !== 'function') return value;
				if (prop === Symbol.asyncIterator) {
					return () => {
						const it = (value as () => AsyncIterator<unknown>).call(target);
						return {
							async next() {
								const step = await it.next();
								if (!step.done) counter.rows += 1;
								return step;
							},
						};
					};
				}
				return (...args: unknown[]) => {
					const result = (value as (...a: unknown[]) => unknown).apply(target, args);
					if (result instanceof Promise) {
						return result.then((rows: unknown) => {
							if (Array.isArray(rows)) counter.rows += rows.length;
							else if (rows && typeof rows === 'object' && 'page' in rows) {
								counter.rows += (rows as { page: unknown[] }).page.length;
							} else if (rows) counter.rows += 1;
							return rows;
						});
					}
					return typeof result === 'object' && result !== null ? counted(result) : result;
				};
			},
		});
	const table = (query: object): object =>
		new Proxy(query, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (typeof value !== 'function') return value;
				return (...args: unknown[]) => {
					const result = (value as (...a: unknown[]) => object).apply(target, args);
					return prop === 'withIndex' && args[0] === 'by_mailbox_and_unseen'
						? counted(result)
						: result;
				};
			},
		});
	return new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop) as unknown;
			if (typeof value !== 'function') return value;
			if (prop !== 'query') return (value as (...a: unknown[]) => unknown).bind(target);
			return (name: string) => {
				const query = (value as (n: string) => object).call(target, name);
				return name === 'mailMessages' ? table(query) : query;
			};
		},
	});
}

/**
 * Drive `markLabelRead` as the client does, through a db that counts the rows
 * each call reads from the unseen walk.
 */
async function markLabelAllReadCounted(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	labelId: Id<'mailLabels'>
): Promise<{ rowsPerCall: number[] }> {
	const handler = (
		markLabelRead as unknown as {
			_handler: (ctx: MutationCtx, args: Record<string, unknown>) => Promise<LabelAnswer>;
		}
	)._handler;
	const rowsPerCall: number[] = [];
	let next: { ceilingTime?: number; cursor?: string } = {};
	for (;;) {
		const counter = { rows: 0 };
		const answer = await t.run(async (ctx) =>
			handler(
				{ ...ctx, db: unseenWalkCountingDb(ctx.db, counter) },
				{ mailboxId, labelId, ...next }
			)
		);
		rowsPerCall.push(counter.rows);
		if (answer.cursor === null) break;
		next = { ceilingTime: answer.ceilingTime, cursor: answer.cursor };
	}
	return { rowsPerCall };
}

/** Drive `markCategoryRead` the way the client does, keeping each batch's ids. */
async function markCategoryAllRead(
	t: TestConvex<typeof schema>,
	folderId: Id<'mailFolders'>,
	category: 'newsletter' | 'person' | 'other',
	betweenBatches?: () => Promise<void>
): Promise<{ batches: Id<'mailMessages'>[][] }> {
	const batches: Id<'mailMessages'>[][] = [];
	let cursor: { ceilingUid: number; afterUid: number } | null = null;
	for (;;) {
		const answer: { markedIds: Id<'mailMessages'>[]; ceilingUid: number; afterUid: number | null } =
			await t.mutation(api.mail.folderBulk.markCategoryRead, { folderId, category, ...cursor });
		batches.push(answer.markedIds);
		if (answer.afterUid === null) break;
		cursor = { ceilingUid: answer.ceilingUid, afterUid: answer.afterUid };
		await betweenBatches?.();
	}
	return { batches };
}

async function seedPersonal(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	for (const role of ['inbox', 'archive', 'trash', 'spam'] as const) {
		await seedFolder(t, mailboxId, role);
	}
	return mailboxId;
}

describe('markFolderRead', () => {
	it('marks every unread message in the folder across batches, and nothing elsewhere', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const inboxIds = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 5);
		const archiveIds = await seedMessages(t, mailboxId, 'archive', 2);
		const inbox = await folderOf(t, mailboxId, 'inbox');

		const { markedIds, calls } = await markAllRead(t, inbox._id);

		expect(calls).toBe(2);
		expect(new Set(markedIds)).toEqual(new Set(inboxIds));
		expect(await unreadIds(t, inbox._id)).toEqual([]);
		expect((await folderOf(t, mailboxId, 'inbox')).unseenCount).toBe(0);
		const archive = await folderOf(t, mailboxId, 'archive');
		expect(new Set(await unreadIds(t, archive._id))).toEqual(new Set(archiveIds));
		expect(archive.unseenCount).toBe(2);
	});

	it('leaves mail that arrived after the first batch unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 1);
		const inbox = await folderOf(t, mailboxId, 'inbox');

		let late: Id<'mailMessages'>[] = [];
		await markAllRead(t, inbox._id, async () => {
			late = await seedMessages(t, mailboxId, 'inbox', 1, { subjectPrefix: 'late' });
		});

		expect(await unreadIds(t, inbox._id)).toEqual(late);
	});

	it('skips snoozed messages so they come back unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const [snoozed, plain] = await seedMessages(t, mailboxId, 'inbox', 2);
		await t.run(async (ctx) => {
			await ctx.db.patch(snoozed!, { snoozedUntil: Date.now() + 60 * 60 * 1000 });
		});
		const inbox = await folderOf(t, mailboxId, 'inbox');

		const { markedIds } = await markAllRead(t, inbox._id);

		expect(markedIds).toEqual([plain]);
		expect(await unreadIds(t, inbox._id)).toEqual([snoozed]);
	});

	it('refuses a folder the caller cannot access', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'inbox', 1);
		const inbox = await folderOf(t, mailboxId, 'inbox');
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';

		await expect(
			t.mutation(api.mail.folderBulk.markFolderRead, { folderId: inbox._id })
		).rejects.toThrow();
		expect(await unreadIds(t, inbox._id)).toHaveLength(1);
	});
});

describe('markLabelRead', () => {
	it("marks only the label's unread mail, in every folder, across batches", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const other = await seedLabel(t, mailboxId, 'other');
		const labelled = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH);
		const archived = await seedMessages(t, mailboxId, 'archive', 2);
		const unlabelled = await seedMessages(t, mailboxId, 'inbox', 3, { subjectPrefix: 'plain' });
		const otherLabel = await seedMessages(t, mailboxId, 'inbox', 2, { subjectPrefix: 'other' });
		await setLabels(t, [...labelled, ...archived], [work]);
		await setLabels(t, otherLabel, [other]);

		const { batches } = await markLabelAllRead(t, mailboxId, work);

		expect(new Set(batches.flat())).toEqual(new Set([...labelled, ...archived]));
		expect(batches.flat()).toHaveLength(labelled.length + archived.length);
		expect(await unreadOf(t, [...labelled, ...archived])).toEqual([]);
		expect(await unreadOf(t, [...unlabelled, ...otherLabel])).toEqual([
			...unlabelled,
			...otherLabel,
		]);
		expect((await folderOf(t, mailboxId, 'inbox')).unseenCount).toBe(5);
	});

	it('hands back exactly the ids each batch flipped', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const ids = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 3);
		await setLabels(t, ids, [work]);
		const readEarlier = await unreadOf(t, ids);

		const seenAfterBatch: Id<'mailMessages'>[][] = [];
		const { batches } = await markLabelAllRead(t, mailboxId, work, async () => {
			const stillUnread = new Set(await unreadOf(t, ids));
			seenAfterBatch.push(readEarlier.filter((id) => !stillUnread.has(id)));
		});

		expect(batches).toHaveLength(2);
		expect(new Set(batches[0])).toEqual(new Set(seenAfterBatch[0]));
		expect(new Set(batches.flat())).toEqual(new Set(ids));
	});

	it('leaves labelled mail that arrived after the first batch unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const ids = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 1);
		await setLabels(t, ids, [work]);

		let late: Id<'mailMessages'>[] = [];
		const { batches } = await markLabelAllRead(t, mailboxId, work, async () => {
			late = await seedMessages(t, mailboxId, 'inbox', 1, { subjectPrefix: 'late' });
			await setLabels(t, late, [work]);
		});

		expect(new Set(batches.flat())).toEqual(new Set(ids));
		expect(await unreadOf(t, late)).toEqual(late);
	});

	it('marks every labelled message that shares one creation time, past a full batch', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const tied = await withCreationTime(Date.now(), () =>
			seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 1)
		);
		await setLabels(t, tied, [work]);

		const { batches } = await markLabelAllRead(t, mailboxId, work);

		expect(new Set(batches.flat())).toEqual(new Set(tied));
		expect(await unreadOf(t, tied)).toEqual([]);
	});

	it('keeps going inside one creation time after a batch that matched nothing', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		// One import batch: a full read of unlabelled mail, then the labelled
		// mail after it in index order, all at one creation time.
		const { plain, labelled } = await withCreationTime(Date.now(), async () => ({
			plain: await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH, {
				subjectPrefix: 'plain',
			}),
			labelled: await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 1),
		}));
		await setLabels(t, labelled, [work]);

		const { batches } = await markLabelAllRead(t, mailboxId, work);

		expect(batches[0]).toEqual([]);
		expect(new Set(batches.flat())).toEqual(new Set(labelled));
		expect(await unreadOf(t, labelled)).toEqual([]);
		expect(await unreadOf(t, plain)).toEqual(plain);
	});

	it('reads a bounded number of rows per call however large a creation-time tie is', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const tieSize = 10 * MARK_FOLDER_READ_BATCH;
		// One import batch: many batches of unlabelled unread mail, then a few
		// labelled messages after them in index order, all at one creation time.
		const { plain, labelled } = await withCreationTime(Date.now(), async () => ({
			plain: await seedMessages(t, mailboxId, 'inbox', tieSize, { subjectPrefix: 'plain' }),
			labelled: await seedMessages(t, mailboxId, 'inbox', 5),
		}));
		await setLabels(t, labelled, [work]);

		const { rowsPerCall } = await markLabelAllReadCounted(t, mailboxId, work);

		// The first call also reads the newest unread row for its ceiling.
		for (const rows of rowsPerCall) expect(rows).toBeLessThanOrEqual(MARK_FOLDER_READ_BATCH + 1);
		const unseenRows = plain.length + labelled.length;
		expect(rowsPerCall.length).toBeLessThanOrEqual(unseenRows / MARK_FOLDER_READ_BATCH + 2);
		expect(rowsPerCall.reduce((sum, rows) => sum + rows, 0)).toBeLessThanOrEqual(unseenRows + 2);
		expect(await unreadOf(t, labelled)).toEqual([]);
		expect(await unreadOf(t, plain)).toHaveLength(plain.length);
	});

	it('skips snoozed labelled mail', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const [snoozed, plain] = await seedMessages(t, mailboxId, 'inbox', 2);
		await setLabels(t, [snoozed!, plain!], [work]);
		await t.run(async (ctx) => {
			await ctx.db.patch(snoozed!, { snoozedUntil: Date.now() + 60 * 60 * 1000 });
		});

		const { batches } = await markLabelAllRead(t, mailboxId, work);

		expect(batches.flat()).toEqual([plain]);
		expect(await unreadOf(t, [snoozed!])).toEqual([snoozed]);
	});

	it("refuses a label from another mailbox, and a mailbox the caller can't read", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const work = await seedLabel(t, mailboxId, 'work');
		const ids = await seedMessages(t, mailboxId, 'inbox', 1);
		await setLabels(t, ids, [work]);
		const foreignMailbox = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const foreignLabel = await seedLabel(t, foreignMailbox, 'theirs');

		await expect(
			t.mutation(api.mail.folderBulk.markLabelRead, { mailboxId, labelId: foreignLabel })
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.folderBulk.markLabelRead, {
				mailboxId: foreignMailbox,
				labelId: work,
			})
		).rejects.toThrow();

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(
			t.mutation(api.mail.folderBulk.markLabelRead, { mailboxId, labelId: work })
		).rejects.toThrow();
		expect(await unreadOf(t, ids)).toEqual(ids);
	});
});

describe('setFlags for a bundle', () => {
	it('answers with only the ids it moved from unread to read', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const [unread, readElsewhere] = await seedMessages(t, mailboxId, 'inbox', 2);
		// Another client read this one after the bundle row was drawn.
		await t.mutation(api.mail.messageActions.setFlags, {
			messageIds: [readElsewhere!],
			seen: true,
		});

		const answer = await t.mutation(api.mail.messageActions.setFlags, {
			messageIds: [unread!, readElsewhere!],
			seen: true,
		});

		expect(answer.seenChangedIds).toEqual([unread]);
	});
});

describe('markCategoryRead', () => {
	it("marks only the category's unread mail in that folder, across batches", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const news = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 2);
		const people = await seedMessages(t, mailboxId, 'inbox', 2, { subjectPrefix: 'person' });
		const archivedNews = await seedMessages(t, mailboxId, 'archive', 1);
		await setCategory(t, [...news, ...archivedNews], 'newsletter');
		await setCategory(t, people, 'person');
		const inbox = await folderOf(t, mailboxId, 'inbox');

		const { batches } = await markCategoryAllRead(t, inbox._id, 'newsletter');

		expect(batches.length).toBeGreaterThanOrEqual(2);
		expect(new Set(batches.flat())).toEqual(new Set(news));
		expect(batches.flat()).toHaveLength(news.length);
		expect(await unreadOf(t, [...people, ...archivedNews])).toEqual([...people, ...archivedNews]);
		expect((await folderOf(t, mailboxId, 'inbox')).unseenCount).toBe(2);
	});

	it('counts uncategorised mail as "Everything else"', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const [uncategorised, person] = await seedMessages(t, mailboxId, 'inbox', 2);
		await setCategory(t, [person!], 'person');
		const inbox = await folderOf(t, mailboxId, 'inbox');

		const { batches } = await markCategoryAllRead(t, inbox._id, 'other');

		expect(batches.flat()).toEqual([uncategorised]);
		expect(await unreadOf(t, [person!])).toEqual([person]);
	});

	it('leaves mail of the category that arrived after the first batch unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const news = await seedMessages(t, mailboxId, 'inbox', MARK_FOLDER_READ_BATCH + 1);
		await setCategory(t, news, 'newsletter');
		const inbox = await folderOf(t, mailboxId, 'inbox');

		let late: Id<'mailMessages'>[] = [];
		await markCategoryAllRead(t, inbox._id, 'newsletter', async () => {
			late = await seedMessages(t, mailboxId, 'inbox', 1, { subjectPrefix: 'late' });
			await setCategory(t, late, 'newsletter');
		});

		expect(await unreadIds(t, inbox._id)).toEqual(late);
	});

	it('refuses a folder the caller cannot access', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		const ids = await seedMessages(t, mailboxId, 'inbox', 1);
		await setCategory(t, ids, 'newsletter');
		const inbox = await folderOf(t, mailboxId, 'inbox');
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';

		await expect(
			t.mutation(api.mail.folderBulk.markCategoryRead, {
				folderId: inbox._id,
				category: 'newsletter',
			})
		).rejects.toThrow();
		expect(await unreadOf(t, ids)).toEqual(ids);
	});
});

describe('emptyFolder', () => {
	it('deletes everything in Trash, continuing on the scheduler', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'trash', EMPTY_FOLDER_BATCH + 3, { flagSeen: true });
		await seedMessages(t, mailboxId, 'inbox', 1);
		const trash = await folderOf(t, mailboxId, 'trash');

		const first = await t.mutation(api.mail.folderBulk.emptyFolder, { folderId: trash._id });
		expect(first).toEqual({ purged: EMPTY_FOLDER_BATCH, more: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await countIn(t, trash._id)).toBe(0);
		expect((await folderOf(t, mailboxId, 'trash')).totalCount).toBe(0);
		expect(await countIn(t, (await folderOf(t, mailboxId, 'inbox'))._id)).toBe(1);
	});

	it('empties Spam too', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'spam', 2);
		const spam = await folderOf(t, mailboxId, 'spam');

		await t.mutation(api.mail.folderBulk.emptyFolder, { folderId: spam._id });

		expect(await countIn(t, spam._id)).toBe(0);
	});

	it('refuses any folder other than Trash and Spam', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedPersonal(t);
		await seedMessages(t, mailboxId, 'inbox', 1);
		const inbox = await folderOf(t, mailboxId, 'inbox');

		await expect(
			t.mutation(api.mail.folderBulk.emptyFolder, { folderId: inbox._id })
		).rejects.toThrow(/Trash and Spam/);
		expect(await countIn(t, inbox._id)).toBe(1);
	});

	it("needs the owner role on a team inbox's Trash", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, {
			userId: 'user-A',
			scope: 'shared',
			address: 'support@owlat.test',
		});
		await seedFolder(t, mailboxId, 'trash');
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [authUserId, role] of [
				['user-A', 'owner'],
				['user-B', 'member'],
			] as const) {
				await ctx.db.insert('mailboxMembers', {
					mailboxId,
					authUserId,
					role,
					addedBy: 'user-A',
					createdAt: now,
				});
			}
		});
		await seedMessages(t, mailboxId, 'trash', 1);
		const trash = await folderOf(t, mailboxId, 'trash');

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(
			t.mutation(api.mail.folderBulk.emptyFolder, { folderId: trash._id })
		).rejects.toThrow(/permission/);
		expect(await countIn(t, trash._id)).toBe(1);

		sessionMocks.userId = 'user-A';
		await t.mutation(api.mail.folderBulk.emptyFolder, { folderId: trash._id });
		expect(await countIn(t, trash._id)).toBe(0);
	});
});
