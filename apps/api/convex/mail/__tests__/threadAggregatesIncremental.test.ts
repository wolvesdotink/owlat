/**
 * Plan 3.3 — incremental thread aggregates and a paged reader.
 *
 * A star or a mark-read used to re-read every message of the thread (full docs,
 * bodies included) to re-derive `unreadCount` / `hasFlagged`. Flag changes now
 * apply deltas; only move and purge re-derive. The property that matters is
 * that the cheap path never drifts from the expensive one, so the core test
 * drives random operation sequences and checks every thread, folder counter
 * and modseq against the messages themselves after each step.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, type SeededFolderRole } from './helpers.testlib';
import { enableFeatures } from '../../__tests__/factories';
import { MARK_THREAD_READ_BATCH } from '../flagWrites';
import { THREAD_READ_CAP } from '../mailbox/threadReads';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			...session,
			activeOrganizationId: 'org-1',
		})),
	};
});

type T = TestConvex<typeof schema>;
type Folders = Record<SeededFolderRole, Id<'mailFolders'>>;

const ROLES: SeededFolderRole[] = ['inbox', 'archive', 'trash', 'spam', 'sent'];

async function seedBox(t: T): Promise<{ mailboxId: Id<'mailboxes'>; folders: Folders }> {
	await enableFeatures(t, ['mail.external']);
	const mailboxId = await seedMailbox(t, { userId: 'user-A', address: 'me@owlat.test' });
	const folders = {} as Folders;
	for (const role of ROLES) folders[role] = await seedFolder(t, mailboxId, role);
	return { mailboxId, folders };
}

type MessageSpec = {
	seen?: boolean;
	flagged?: boolean;
	role?: SeededFolderRole;
	text?: string;
	outbound?: Doc<'mailMessages'>['outbound'];
};

/** One thread of `specs.length` messages, 1 s apart, thread row and folder counters consistent. */
async function seedThread(
	t: T,
	mailboxId: Id<'mailboxes'>,
	folders: Folders,
	specs: MessageSpec[],
	subject = 'thread'
): Promise<{ threadId: Id<'mailThreads'>; messageIds: Id<'mailMessages'>[] }> {
	return await t.run(async (ctx) => {
		const base = Date.now() - specs.length * 1000;
		const roles = new Set(specs.map((s) => s.role ?? 'inbox'));
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: subject,
			participants: ['sender@example.com'],
			messageCount: specs.length,
			unreadCount: specs.filter((s) => !s.seen).length,
			hasFlagged: specs.some((s) => s.flagged),
			hasAttachments: false,
			lastMessageAt: base + (specs.length - 1) * 1000,
			firstMessageAt: base,
			latestSnippet: subject,
			latestFromAddress: 'sender@example.com',
			latestSubject: subject,
			folderRoles: [...roles],
			labelIds: [],
			createdAt: base,
			updatedAt: base,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageIds: Id<'mailMessages'>[] = [];
		for (const [i, spec] of specs.entries()) {
			const folderId = folders[spec.role ?? 'inbox'];
			const folder = (await ctx.db.get(folderId))!;
			const receivedAt = base + i * 1000;
			messageIds.push(
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId,
					uid: folder.uidNext,
					modseq: folder.highestModseq + 1,
					rfc822MessageId: `<${subject}-${i}@example.com>`,
					threadId,
					fromAddress: 'sender@example.com',
					toAddresses: ['me@owlat.test'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `${subject} ${i}`,
					normalizedSubject: subject,
					snippet: `${subject} ${i}`,
					textBodyInline: spec.text ?? `body ${i}`,
					rawStorageId,
					rawSize: 3,
					attachments: [],
					hasAttachments: false,
					flagSeen: spec.seen ?? false,
					flagFlagged: spec.flagged ?? false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					...(spec.outbound ? { outbound: spec.outbound } : {}),
					receivedAt,
					internalDate: receivedAt,
					createdAt: receivedAt,
					updatedAt: receivedAt,
				})
			);
			await ctx.db.patch(folderId, {
				uidNext: folder.uidNext + 1,
				highestModseq: folder.highestModseq + 1,
				totalCount: folder.totalCount + 1,
				unseenCount: folder.unseenCount + (spec.seen ? 0 : 1),
			});
		}
		return { threadId, messageIds };
	});
}

/**
 * Every invariant the aggregates promise, checked against the messages: thread
 * counters equal a from-scratch derivation, an emptied thread is gone, folder
 * counters match their rows, and no row's modseq is ahead of its folder's.
 */
async function expectConsistent(t: T, mailboxId: Id<'mailboxes'>): Promise<void> {
	await t.run(async (ctx) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		const roleOf = new Map(folders.map((f) => [f._id, f.role]));

		for (const thread of threads) {
			const own = messages.filter((m) => m.threadId === thread._id);
			expect(own.length, 'an emptied thread is deleted').toBeGreaterThan(0);
			expect({
				messageCount: thread.messageCount,
				unreadCount: thread.unreadCount,
				hasFlagged: thread.hasFlagged,
				folderRoles: [...thread.folderRoles].sort(),
			}).toEqual({
				messageCount: own.length,
				unreadCount: own.filter((m) => !m.flagSeen).length,
				hasFlagged: own.some((m) => m.flagFlagged),
				folderRoles: [...new Set(own.map((m) => roleOf.get(m.folderId)!))].sort(),
			});
		}
		for (const m of messages) {
			expect(threads.some((th) => th._id === m.threadId)).toBe(true);
		}
		for (const folder of folders) {
			const own = messages.filter((m) => m.folderId === folder._id);
			expect({ total: folder.totalCount, unseen: folder.unseenCount }).toEqual({
				total: own.length,
				unseen: own.filter((m) => !m.flagSeen).length,
			});
			for (const m of own) expect(m.modseq).toBeLessThanOrEqual(folder.highestModseq);
		}
	});
}

/** Deterministic PRNG (mulberry32), so a failing sequence replays exactly. */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let x = Math.imul(a ^ (a >>> 15), 1 | a);
		x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('thread aggregates stay exact under deltas (plan 3.3)', () => {
	it.each([1, 2, 3])('random op sequence %i keeps every aggregate consistent', async (seed) => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const random = rng(seed);
		const pick = <X>(xs: X[]): X => xs[Math.floor(random() * xs.length)]!;
		const threadSpecs = (n: number): MessageSpec[] =>
			Array.from({ length: n }, () => ({ seen: random() < 0.5, flagged: random() < 0.3 }));
		const seeded = [
			await seedThread(t, mailboxId, folders, threadSpecs(6), 'alpha'),
			await seedThread(t, mailboxId, folders, threadSpecs(4), 'beta'),
			await seedThread(t, mailboxId, folders, threadSpecs(3), 'gamma'),
		];
		await expectConsistent(t, mailboxId);

		const liveMessages = async () =>
			await t.run(async (ctx) =>
				(
					await ctx.db
						.query('mailMessages')
						.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
						.collect()
				).map((m) => m._id)
			);
		const someOf = (ids: Id<'mailMessages'>[]) => ids.filter(() => random() < 0.4);

		for (let step = 0; step < 40; step++) {
			const ids = await liveMessages();
			if (ids.length === 0) break;
			const op = random();
			if (op < 0.2) {
				await t.mutation(api.mail.messageActions.setFlags, {
					messageIds: someOf(ids),
					...(random() < 0.5 ? { seen: random() < 0.5 } : {}),
					...(random() < 0.5 ? { flagged: random() < 0.5 } : { answered: true }),
				});
			} else if (op < 0.35) {
				await t.mutation(api.mail.messageActions.setStar, {
					messageId: pick(ids),
					starred: random() < 0.5,
				});
			} else if (op < 0.5) {
				await t.mutation(api.mail.messageActions.markRead, {
					messageId: pick(ids),
					seen: random() < 0.5,
				});
			} else if (op < 0.65) {
				await t.mutation(api.mail.messageActions.markThreadRead, {
					threadId: pick(seeded).threadId,
					seen: random() < 0.5,
				});
			} else if (op < 0.75) {
				await t.mutation(api.mail.messageActions.move, {
					messageIds: someOf(ids),
					targetFolderId: folders[pick<SeededFolderRole>(['inbox', 'archive', 'spam'])],
				});
			} else if (op < 0.85) {
				await t.mutation(api.mail.messageActions.archive, { messageIds: [pick(ids)] });
			} else if (op < 0.95) {
				await t.mutation(api.mail.messageActions.trash, { messageIds: [pick(ids)] });
			} else {
				await t.mutation(api.mail.messageActions.purge, { messageIds: [pick(ids)] });
			}
			await expectConsistent(t, mailboxId);
		}
	});

	it('unflagging keeps hasFlagged while another message is still starred', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			{ flagged: true },
			{ flagged: true },
			{},
		]);
		const hasFlagged = async () => (await t.run((ctx) => ctx.db.get(threadId)))!.hasFlagged;

		await t.mutation(api.mail.messageActions.setStar, {
			messageId: messageIds[0]!,
			starred: false,
		});
		expect(await hasFlagged()).toBe(true);
		await t.mutation(api.mail.messageActions.setStar, {
			messageId: messageIds[1]!,
			starred: false,
		});
		expect(await hasFlagged()).toBe(false);
		await t.mutation(api.mail.messageActions.setStar, {
			messageId: messageIds[2]!,
			starred: true,
		});
		expect(await hasFlagged()).toBe(true);
	});

	it('a flag change that moves no aggregate leaves the thread row unwritten', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			{ seen: true },
			{ seen: true, flagged: true },
		]);
		const before = await t.run((ctx) => ctx.db.get(threadId));
		vi.advanceTimersByTime(5000);

		// Answered, a re-star of a starred message, a re-read of a read one: the
		// thread's counters do not change, so its subscribers must not re-run.
		await t.mutation(api.mail.messageActions.setFlags, {
			messageIds,
			answered: true,
		});
		await t.mutation(api.mail.messageActions.setStar, {
			messageId: messageIds[1]!,
			starred: true,
		});
		await t.mutation(api.mail.messageActions.markThreadRead, { threadId, seen: true });

		expect(await t.run((ctx) => ctx.db.get(threadId))).toEqual(before);
	});

	it('mark-thread-read gives each flipped message its own modseq and writes the folder once', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const { threadId, messageIds } = await seedThread(t, mailboxId, folders, [
			{},
			{ seen: true },
			{},
			{},
		]);
		const folderBefore = (await t.run((ctx) => ctx.db.get(folders.inbox)))!;

		await t.mutation(api.mail.messageActions.markThreadRead, { threadId, seen: true });

		const { rows, folder, thread } = await t.run(async (ctx) => ({
			rows: await Promise.all(messageIds.map((id) => ctx.db.get(id))),
			folder: (await ctx.db.get(folders.inbox))!,
			thread: (await ctx.db.get(threadId))!,
		}));
		const flipped = [rows[0]!, rows[2]!, rows[3]!];
		expect(flipped.map((m) => m.modseq)).toEqual([
			folderBefore.highestModseq + 1,
			folderBefore.highestModseq + 2,
			folderBefore.highestModseq + 3,
		]);
		// The already-read row was not touched.
		expect(rows[1]!.modseq).toBeLessThanOrEqual(folderBefore.highestModseq);
		expect(folder.highestModseq).toBe(folderBefore.highestModseq + 3);
		expect(folder.unseenCount).toBe(folderBefore.unseenCount - 3);
		expect(thread.unreadCount).toBe(0);
	});

	it('mark-thread-read over a thread larger than one batch finishes in a continuation', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const size = MARK_THREAD_READ_BATCH + 30;
		const { threadId } = await seedThread(
			t,
			mailboxId,
			folders,
			Array.from({ length: size }, () => ({}))
		);

		await t.mutation(api.mail.messageActions.markThreadRead, { threadId, seen: true });
		const midway = (await t.run((ctx) => ctx.db.get(threadId)))!;
		expect(midway.unreadCount).toBe(30);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
		expect(thread.unreadCount).toBe(0);
		await expectConsistent(t, mailboxId);
	});
});

describe('listThreadMessages paging (plan 3.3)', () => {
	it('without paging arguments returns the whole thread with bodies, oldest first', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const { messageIds } = await seedThread(
			t,
			mailboxId,
			folders,
			Array.from({ length: 5 }, (_, i) => ({ text: `text ${i}` }))
		);

		const result = (await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId: messageIds[2]!,
		}))!;
		expect(result.messages.map((m) => m._id)).toEqual(messageIds);
		expect(result.messages.map((m) => m.textBodyInline)).toEqual(
			messageIds.map((_, i) => `text ${i}`)
		);
		expect(result.envelopes).toEqual([]);
		expect(result.olderCursor).toBeNull();
	});

	it('pages newest first: newest N with bodies, older as envelopes, a cursor for more', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const { messageIds } = await seedThread(
			t,
			mailboxId,
			folders,
			Array.from({ length: 7 }, (_, i) => ({ text: `text ${i}` }))
		);
		const messageId = messageIds[6]!;

		const first = (await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId,
			pageSize: 3,
			withBodies: 2,
		}))!;
		expect(first.messages.map((m) => m._id)).toEqual([messageIds[5], messageIds[6]]);
		expect(first.messages[1]!.textBodyInline).toBe('text 6');
		expect(first.envelopes.map((m) => m._id)).toEqual([messageIds[4]]);
		expect(first.envelopes[0]).not.toHaveProperty('textBodyInline');
		expect(first.envelopes[0]!.snippet).toBe('thread 4');
		expect(first.olderCursor).not.toBeNull();

		const second = (await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId,
			pageSize: 3,
			withBodies: 0,
			cursor: first.olderCursor,
		}))!;
		expect(second.messages).toEqual([]);
		expect(second.envelopes.map((m) => m._id)).toEqual(messageIds.slice(1, 4));
		expect(second.olderCursor).not.toBeNull();

		const last = (await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId,
			pageSize: 3,
			withBodies: 0,
			cursor: second.olderCursor,
		}))!;
		expect(last.envelopes.map((m) => m._id)).toEqual([messageIds[0]]);
		expect(last.olderCursor).toBeNull();
	});

	it('caps an unpaged read at the newest THREAD_READ_CAP messages', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const { messageIds } = await seedThread(
			t,
			mailboxId,
			folders,
			Array.from({ length: THREAD_READ_CAP + 5 }, () => ({ seen: true }))
		);

		const result = (await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId: messageIds[0]!,
		}))!;
		expect(result.messages).toHaveLength(THREAD_READ_CAP);
		expect(result.messages[result.messages.length - 1]!._id).toBe(
			messageIds[messageIds.length - 1]
		);
		expect(result.messages[0]!._id).toBe(messageIds[5]);
		expect(result.olderCursor).not.toBeNull();
	});
});

describe('listThreadOutboundDelivery reads only sent rows (plan 3.3)', () => {
	it('returns every sent row across states in arrival order and skips inbound', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedBox(t);
		const outbound = (state: 'queued' | 'sent' | 'bounced' | 'partial') => ({
			state,
			recipients: [
				{
					idx: 0,
					address: 'them@example.com',
					mtaJobId: 'job',
					state: state === 'partial' ? ('sent' as const) : state,
				},
			],
		});
		const { messageIds } = await seedThread(t, mailboxId, folders, [
			{ role: 'sent', outbound: outbound('bounced') },
			{ seen: true },
			{ role: 'sent', outbound: outbound('sent') },
			{ role: 'sent', outbound: outbound('queued') },
			{},
			{ role: 'sent', outbound: outbound('partial') },
		]);

		const rows = (await t.query(api.mail.mailbox.messages.listThreadOutboundDelivery, {
			messageId: messageIds[1]!,
		}))!;
		expect(rows.map((r) => [r.messageId, r.state])).toEqual([
			[messageIds[0], 'bounced'],
			[messageIds[2], 'sent'],
			[messageIds[3], 'queued'],
			[messageIds[5], 'partial'],
		]);
		expect(rows[0]!.recipients[0]).not.toHaveProperty('mtaJobId');
	});
});
