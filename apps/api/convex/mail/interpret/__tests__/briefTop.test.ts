/**
 * The thread brief folded down for list rows (`mailThreads.briefTop`) and the
 * Workbench "To do, no reply needed" band:
 *   - an item's list bucket and the thread's maintained counters: proposals
 *     and closed items never count as tracked work;
 *   - refreshBriefTop takes the counts from the counters and the top item from
 *     the first row of the thread's `forUs` (else `waitingOnOthers`) list, with
 *     O(1) reads however long the thread; it keeps the stored latest line
 *     unless given a new one, and never writes one in actions mode;
 *   - list rows and Answer queue rows carry it unsealed;
 *   - the band lists threads with open for-you items that need no reply.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { refreshBriefTop } from '../briefTop';
import {
	itemBucketOf,
	itemCountsOf,
	listBucketOf,
	recordItemChange,
	writeItemChange,
} from '../counters';
import { collectToDo, TODO_SCAN_BUDGET } from '../todo';
import type { MutationCtx } from '../../../_generated/server';

const SESSION = { userId: 'test-user', role: 'owner', activeOrganizationId: 'test-org' };
const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
	requireOrgMember: vi.fn(),
}));
vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireOrgMember: sessionMocks.requireOrgMember,
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(SESSION);
	sessionMocks.requireOrgMember.mockResolvedValue(SESSION);
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 7, 9);

describe('list buckets', () => {
	it('keeps proposals and closed items out of tracked work', () => {
		const open = { status: 'open', responsibility: 'us', verify: 'passed' } as const;
		expect(listBucketOf(open)).toBe('forUs');
		expect(listBucketOf({ ...open, responsibility: 'them' })).toBe('waitingOnOthers');
		expect(listBucketOf({ ...open, responsibility: 'unclear' })).toBe('unclear');
		expect(listBucketOf({ ...open, verify: 'proposal' })).toBe('proposal');
		expect(itemBucketOf({ ...open, verify: 'proposal', responsibility: 'them' })).toBe('proposal');
		expect(listBucketOf({ ...open, status: 'done' })).toBe('closed');
		expect(itemBucketOf({ ...open, status: 'untracked' })).toBe('hidden');
		expect(listBucketOf({ ...open, status: 'untracked' })).toBe('closed');
	});
});

type T = ReturnType<typeof convexTest>;
type ItemFields = Omit<Doc<'threadItems'>, '_id' | '_creationTime' | 'listBucket'>;

/** Insert an item the way every writer must: with its list bucket, counters moved. */
async function trackedInsert(ctx: MutationCtx, fields: ItemFields): Promise<Id<'threadItems'>> {
	const id = await ctx.db.insert('threadItems', { ...fields, listBucket: listBucketOf(fields) });
	await recordItemChange(ctx, { kind: 'mail', id: fields.mailThreadId! }, null, fields);
	return id;
}

/**
 * `ctx` with a `db` that counts the documents its reads return (get, first,
 * unique, take, collect, async iteration): what a mutation pays for.
 */
function countingReads(ctx: MutationCtx): { ctx: MutationCtx; reads: () => number } {
	let reads = 0;
	const wrap = (query: object): object =>
		new Proxy(query, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (prop === Symbol.asyncIterator && typeof value === 'function') {
					return () => {
						const inner = (value as () => AsyncIterator<unknown>).call(target);
						return {
							next: async () => {
								const step = await inner.next();
								if (!step.done) reads++;
								return step;
							},
							[Symbol.asyncIterator]() {
								return this;
							},
						};
					};
				}
				if (typeof value !== 'function') return value;
				return (...args: unknown[]) => {
					const out = (value as (...a: unknown[]) => unknown).apply(target, args);
					if (out instanceof Promise) {
						return out.then((res) => {
							reads += Array.isArray(res) ? res.length : res ? 1 : 0;
							return res;
						});
					}
					return out && typeof out === 'object' ? wrap(out) : out;
				};
			},
		});
	const db = new Proxy(ctx.db, {
		get(target, prop) {
			if (prop === 'query') return (table: string) => wrap(target.query(table as never));
			if (prop === 'get') {
				return async (id: never) => {
					const doc = await target.get(id);
					if (doc) reads++;
					return doc;
				};
			}
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
		},
	});
	return { ctx: { ...ctx, db } as MutationCtx, reads: () => reads };
}

async function seedInterpreted(
	t: T,
	mode: 'brief' | 'actions' = 'brief'
): Promise<{ mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'> }> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'Invoice 2026-10',
		fromAddress: 'billing@example.com',
		fromName: 'Hetzner Online',
	});
	const threadId = await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		const id = message!.threadId;
		await ctx.db.patch(id, { latestMessageId: messageId });
		await ctx.db.insert('threadBriefs', {
			threadKind: 'mail',
			mailThreadId: id,
			mode,
			sourceRevision: 1,
			interpretationRevision: 3,
			lastActivitySeq: 0,
			completeness: 'complete',
			deletionEpoch: 0,
			updatedAt: T0,
		});
		const party = { isUs: false, email: 'billing@example.com' };
		await trackedInsert(ctx, {
			threadKind: 'mail',
			mailThreadId: id,
			mailboxId,
			revision: 1,
			intent: 'request',
			facets: ['payment'],
			assertion: 'Pay the invoice',
			display: { en: 'Pay €38.08', de: 'Zahle 38,08 €' },
			requester: party,
			responsible: { isUs: true },
			responsibility: 'us',
			status: 'open',
			disposition: 'unanswered',
			due: { phrase: 'by 21 Oct', at: T0 + 14 * DAY, isAmbiguous: false },
			evidence: [],
			verify: 'passed',
			askedAt: T0,
			createdAt: T0,
			updatedAt: T0,
		});
		return id;
	});
	return { mailboxId, threadId };
}

describe('refreshBriefTop and the list reads', () => {
	it('projects the top item onto list rows, keeping the latest line until replaced', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedInterpreted(t);
		await t.run((ctx) =>
			refreshBriefTop(ctx, threadId, { latest: { en: 'Invoice is out.', de: 'Rechnung ist da.' } })
		);
		// A reaction refresh passes no latest: the stored one stays.
		await t.run((ctx) => refreshBriefTop(ctx, threadId));

		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			limit: 10,
		});
		expect(result.messages[0]!.briefTop).toEqual({
			mode: 'brief',
			forYou: 1,
			waiting: 0,
			top: {
				itemId: expect.any(String),
				bucket: 'forUs',
				responsibility: 'us',
				text: { en: 'Pay €38.08', de: 'Zahle 38,08 €' },
				dueAt: T0 + 14 * DAY,
			},
			latest: { en: 'Invoice is out.', de: 'Rechnung ist da.' },
			isReplyNeeded: false,
		});
		const stored = await t.run((ctx) => ctx.db.get(threadId));
		expect(stored!.briefTop!.revision).toBe(3);
	});

	it('never stores a latest line for a shared (actions mode) thread', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedInterpreted(t, 'actions');
		await t.run((ctx) => refreshBriefTop(ctx, threadId, { latest: { en: 'x', de: 'y' } }));
		const stored = await t.run((ctx) => ctx.db.get(threadId));
		expect(stored!.briefTop!.mode).toBe('actions');
		expect(stored!.briefTop!.latest).toBeUndefined();
	});
});

describe('listNoReplyToDo', () => {
	it('lists open for-you items of threads that need no reply', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['postbox']);
		const { mailboxId, threadId } = await seedInterpreted(t);
		const { rows, isTruncated } = await t.query(api.mail.interpret.todo.listNoReplyToDo, {
			mailboxId,
		});
		expect(isTruncated).toBe(false);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			threadId,
			text: { en: 'Pay €38.08', de: 'Zahle 38,08 €' },
			dueAt: T0 + 14 * DAY,
			count: 1,
			fromName: 'Hetzner Online',
			subject: 'Invoice 2026-10',
		});
	});

	it('leaves out a thread the Answer queue already shows', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['postbox']);
		const { mailboxId, threadId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			await ctx.db.patch(threadId, {
				needsReply: {
					messageId: thread!.latestMessageId!,
					source: 'llm',
					urgency: 'normal',
					detectedAt: T0,
				},
			});
		});
		expect(await t.query(api.mail.interpret.todo.listNoReplyToDo, { mailboxId })).toEqual({
			rows: [],
			isTruncated: false,
		});
	});
});

// ── Completeness: nothing is dropped silently ─────────────────────────────

const PARTY = { isUs: false, email: 'billing@example.com' };

async function insertThread(ctx: MutationCtx, mailboxId: Id<'mailboxes'>, subject: string) {
	return ctx.db.insert('mailThreads', {
		mailboxId,
		normalizedSubject: subject,
		participants: [],
		messageCount: 1,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
		lastMessageAt: T0,
		firstMessageAt: T0,
		latestSnippet: '',
		latestFromAddress: 'billing@example.com',
		latestSubject: subject,
		folderRoles: ['inbox'],
		labelIds: [],
		createdAt: T0,
		updatedAt: T0,
	});
}

async function insertItem(
	ctx: MutationCtx,
	mailThreadId: Id<'mailThreads'>,
	mailboxId: Id<'mailboxes'>,
	over: {
		dueAt?: number;
		verify?: 'passed' | 'proposal';
		text?: string;
		responsibility?: 'us' | 'them';
	} = {}
) {
	return trackedInsert(ctx, {
		threadKind: 'mail',
		mailThreadId,
		mailboxId,
		revision: 1,
		intent: 'request',
		facets: [],
		assertion: 'x',
		display: { en: over.text ?? 'x', de: over.text ?? 'x' },
		requester: PARTY,
		responsible: { isUs: over.responsibility !== 'them' },
		responsibility: over.responsibility ?? 'us',
		status: 'open',
		disposition: 'unanswered',
		...(over.dueAt !== undefined
			? { due: { phrase: 'by then', at: over.dueAt, isAmbiguous: false } }
			: {}),
		evidence: [],
		verify: over.verify ?? 'passed',
		askedAt: T0,
		createdAt: T0,
		updatedAt: T0,
	});
}

describe('the to-do band never drops a thread silently', () => {
	it('shows an overdue invoice even behind more than a hundred undated items', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedInterpreted(t);
		const { overdue } = await t.run(async (ctx) => {
			const noise = await insertThread(ctx, mailboxId, 'Checklist');
			for (let i = 0; i < 120; i++) await insertItem(ctx, noise, mailboxId);
			const invoice = await insertThread(ctx, mailboxId, 'Overdue invoice');
			await insertItem(ctx, invoice, mailboxId, { dueAt: T0 - DAY, text: 'Pay now' });
			return { overdue: invoice };
		});
		const { candidates } = await t.run((ctx) => collectToDo(ctx, mailboxId));
		expect(candidates[0]?.thread._id).toBe(overdue);
		expect(candidates.map((c) => c.thread.latestSubject)).toContain('Checklist');
	});

	it('says it is truncated when proposals use up the read budget', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const noisy = await insertThread(ctx, mailboxId, 'Unconfirmed');
			for (let i = 0; i <= TODO_SCAN_BUDGET; i++) {
				await insertItem(ctx, noisy, mailboxId, { dueAt: T0 - DAY, verify: 'proposal' });
			}
		});
		const result = await t.run((ctx) => collectToDo(ctx, mailboxId));
		expect(result.isTruncated).toBe(true);
	});

	it('says it is truncated when more threads qualify than it shows, and not otherwise', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			for (const subject of ['A', 'B']) {
				await insertItem(ctx, await insertThread(ctx, mailboxId, subject), mailboxId);
			}
		});
		// The seeded invoice (dated) plus A and B (undated).
		const two = await t.run((ctx) => collectToDo(ctx, mailboxId, 2));
		expect(two.candidates.map((c) => c.thread.latestSubject)).toEqual(['Invoice 2026-10', 'A']);
		expect(two.isTruncated).toBe(true);
		const three = await t.run((ctx) => collectToDo(ctx, mailboxId, 3));
		expect(three.candidates).toHaveLength(3);
		expect(three.isTruncated).toBe(false);
	});
});

describe('refreshBriefTop on long threads', () => {
	it('counts 1 tracked item behind 2000 proposals, and takes it as the top', async () => {
		const t = convexTest(schema, modules);
		const { threadId, mailboxId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < 2000; i++) {
				await insertItem(ctx, threadId, mailboxId, { verify: 'proposal', dueAt: T0 - DAY - i });
			}
			await refreshBriefTop(ctx, threadId);
		});
		const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
		// The seeded invoice is the one tracked item; the proposals are apart.
		expect(thread.briefTop).toMatchObject({ forYou: 1, waiting: 0 });
		expect(thread.briefTop!.top?.dueAt).toBe(T0 + 14 * DAY);
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.unique()
		);
		expect(itemCountsOf(brief)).toMatchObject({ us: 1, proposal: 2000 });
	});

	it('refreshes a 10,000-item thread with O(1) reads', async () => {
		const t = convexTest(schema, modules);
		const { threadId, mailboxId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10_000; i++) {
				await ctx.db.insert('threadItems', {
					threadKind: 'mail',
					mailThreadId: threadId,
					mailboxId,
					revision: 1,
					intent: 'request',
					facets: [],
					assertion: 'x',
					display: { en: 'x', de: 'x' },
					requester: PARTY,
					responsible: { isUs: true },
					responsibility: 'us',
					status: 'open',
					disposition: 'unanswered',
					due: { phrase: 'later', at: T0 + 30 * DAY + i, isAmbiguous: false },
					evidence: [],
					verify: 'passed',
					listBucket: 'forUs',
					askedAt: T0,
					createdAt: T0,
					updatedAt: T0,
				});
			}
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.unique();
			const counts = itemCountsOf(brief);
			await ctx.db.patch(brief!._id, { itemCounts: { ...counts, us: counts.us + 10_000 } });
		});
		const reads = await t.run(async (ctx) => {
			const counting = countingReads(ctx);
			await refreshBriefTop(counting.ctx, threadId);
			return counting.reads();
		});
		expect(reads).toBeLessThanOrEqual(4);
		const top = (await t.run((ctx) => ctx.db.get(threadId)))!.briefTop!;
		expect(top.forYou).toBe(10_001);
		expect(top.top?.dueAt).toBe(T0 + 14 * DAY);
	});

	it('finds the top item in its own thread however many other threads are due sooner', async () => {
		const t = convexTest(schema, modules);
		const { threadId, mailboxId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const busy = await insertThread(ctx, mailboxId, 'Busy');
			await ctx.db.insert('threadBriefs', {
				threadKind: 'mail',
				mailThreadId: busy,
				mode: 'brief',
				sourceRevision: 1,
				interpretationRevision: 1,
				lastActivitySeq: 0,
				completeness: 'complete',
				deletionEpoch: 0,
				updatedAt: T0,
			});
			for (let i = 0; i < 600; i++) {
				await insertItem(ctx, busy, mailboxId, { dueAt: T0 - DAY - i });
			}
			await insertItem(ctx, threadId, mailboxId, { dueAt: T0 + DAY, text: 'Soonest' });
			await refreshBriefTop(ctx, threadId);
		});
		const top = (await t.run((ctx) => ctx.db.get(threadId)))!.briefTop!;
		expect(top.top?.dueAt).toBe(T0 + DAY);
		expect(top.forYou).toBe(2);
	});

	it('says "waiting" from the list the top item heads, not from a zero count', async () => {
		const t = convexTest(schema, modules);
		const { threadId, mailboxId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const invoice = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_bucket_asked', (q) =>
					q.eq('mailThreadId', threadId).eq('listBucket', 'forUs')
				)
				.first())!;
			await writeItemChange(ctx, { kind: 'mail', id: threadId }, invoice, { status: 'done' });
			await insertItem(ctx, threadId, mailboxId, { responsibility: 'them', text: 'Photos' });
			await refreshBriefTop(ctx, threadId);
		});
		const top = (await t.run((ctx) => ctx.db.get(threadId)))!.briefTop!;
		expect(top).toMatchObject({ forYou: 0, waiting: 1 });
		expect(top.top).toMatchObject({ bucket: 'waitingOnOthers', responsibility: 'them' });
	});

	it('moves an item and the counters together when a proposal is confirmed', async () => {
		const t = convexTest(schema, modules);
		const { threadId, mailboxId } = await seedInterpreted(t);
		const after = await t.run(async (ctx) => {
			const id = await insertItem(ctx, threadId, mailboxId, { verify: 'proposal' });
			const row = (await ctx.db.get(id))!;
			await writeItemChange(ctx, { kind: 'mail', id: threadId }, row, { verify: 'passed' });
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.unique();
			return { row: await ctx.db.get(id), counts: itemCountsOf(brief) };
		});
		expect(after.row?.listBucket).toBe('forUs');
		expect(after.counts).toMatchObject({ us: 2, proposal: 0 });
	});
});

describe('the Answer queue on a team surface', () => {
	it('never hands a shared mailbox row its AI ask summary', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			await ctx.db.patch(threadId, {
				needsReply: {
					messageId: thread!.latestMessageId!,
					source: 'llm',
					urgency: 'normal',
					askSummary: 'They want the invoice paid',
					detectedAt: T0,
				},
			});
		});
		const personal = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(personal.items[0]?.askSummary).toBe('They want the invoice paid');
		await t.run((ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
		const shared = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(shared.items).toHaveLength(1);
		expect(shared.items[0]?.askSummary).toBeUndefined();
	});
});
