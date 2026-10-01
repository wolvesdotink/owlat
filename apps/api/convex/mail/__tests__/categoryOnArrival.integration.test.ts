/**
 * Smart-inbox category on arrival (plan E7).
 *
 * The override and the deterministic heuristic run inside the insert mutation
 * (`enqueueCategoryCheck`, reached through `runPostInsertInboundEffects`), so a
 * thread is labelled in the same transaction that delivers it. Only mail the
 * heuristic leaves ambiguous schedules `categoryClassify.classifyThread`, and
 * that job is told the baseline is already written.
 *
 * Drives the real forward-sync ingest mutation with the scheduler held (fake
 * timers), so the scheduled LLM job is inspected, never run. The last block
 * runs the action itself with AI off (the default), which is the fail-soft path.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules } from './helpers.testlib';
import {
	ARRIVAL_INBOUND_SCAN,
	ARRIVAL_SPAM_MOVE_MAX_MESSAGES,
	enqueueCategoryCheck,
} from '../categoryArrival';

const OWNER = 'me@gmail.example';
const SENDER = 'sam@acme.test';

type T = TestConvex<typeof schema>;
type Seeded = {
	accountId: Id<'externalMailAccounts'>;
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	spamId: Id<'mailFolders'>;
};

async function seed(t: T): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: OWNER,
			domain: 'gmail.example',
			kind: 'external',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = async (role: 'inbox' | 'spam') =>
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name: role.toUpperCase(),
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
		const inboxId = await folder('inbox');
		const spamId = await folder('spam');
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: OWNER,
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId });
		return { accountId, mailboxId, inboxId, spamId };
	});
}

/** One forward-sync delivery into the INBOX; a reply when `inReplyTo` is set. */
async function ingest(
	t: T,
	seeded: Seeded,
	opts: { uid: number; subject?: string; inReplyTo?: number } = { uid: 1 }
): Promise<void> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
		accountId: seeded.accountId,
		folderRole: 'inbox',
		remoteName: 'INBOX',
		remoteUid: opts.uid,
		remoteUidValidity: 7,
		rawStorageId,
		rawSize: 3,
		from: `Sam <${SENDER}>`,
		to: [OWNER],
		cc: [],
		bcc: [],
		subject: opts.subject ?? 'Friday plans?',
		textBodyInline: 'Can you confirm Friday works?',
		messageId: `<m${opts.uid}@acme.test>`,
		...(opts.inReplyTo ? { inReplyTo: `<m${opts.inReplyTo}@acme.test>` } : {}),
		receivedAt: Date.now() + opts.uid,
		attachments: [],
		origin: 'sync',
	});
}

async function onlyThread(t: T, mailboxId: Id<'mailboxes'>): Promise<Doc<'mailThreads'>> {
	const threads = await t.run(
		async (ctx) =>
			await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
				.collect()
	);
	expect(threads).toHaveLength(1);
	return threads[0]!;
}

/** Pending `categoryClassify` jobs, by their first argument. */
async function categoryJobs(t: T): Promise<Array<Record<string, unknown>>> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('categoryClassify'))
			.map((job) => (job.args[0] ?? {}) as Record<string, unknown>)
	);
}

async function withHeldScheduler(body: () => Promise<void>): Promise<void> {
	vi.useFakeTimers();
	try {
		await body();
	} finally {
		vi.useRealTimers();
	}
}

describe('category on arrival', () => {
	it('labels a known correspondent in the insert and schedules no LLM job', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('mailContacts', {
				mailboxId: seeded.mailboxId,
				email: SENDER,
				useCount: 1,
				lastUsedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1 });

			const thread = await onlyThread(t, seeded.mailboxId);
			expect(thread.category).toMatchObject({ label: 'person', source: 'heuristic' });
			expect(await categoryJobs(t)).toEqual([]);
		});
	});

	it('labels a receipt from its subject in the insert', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1, subject: 'Your order confirmation' });

			const thread = await onlyThread(t, seeded.mailboxId);
			expect(thread.category).toMatchObject({ label: 'receipt', source: 'heuristic' });
			expect(await categoryJobs(t)).toEqual([]);
		});
	});

	it('writes the other baseline for ambiguous mail and schedules the LLM told so', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1 });

			const thread = await onlyThread(t, seeded.mailboxId);
			expect(thread.category).toMatchObject({ label: 'other', source: 'heuristic' });
			expect(await categoryJobs(t)).toEqual([
				expect.objectContaining({ threadId: thread._id, baselineApplied: true }),
			]);
		});
	});

	it('applies a remembered spam override in the insert and files the mail as spam', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('mailSenderCategoryOverrides', {
				mailboxId: seeded.mailboxId,
				senderEmail: SENDER,
				label: 'spam',
				updatedAt: Date.now(),
			});
		});

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1 });

			const thread = await onlyThread(t, seeded.mailboxId);
			expect(thread.category).toMatchObject({ label: 'spam', source: 'user' });
			const folders = await t.run(async (ctx) =>
				(
					await ctx.db
						.query('mailMessages')
						.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
						.collect()
				).map((m) => m.folderId)
			);
			expect(folders).toEqual([seeded.spamId]);
			expect(await categoryJobs(t)).toEqual([]);
		});
	});

	it('keeps a standing LLM label while an ambiguous follow-up is re-classified', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1 });
			const first = await onlyThread(t, seeded.mailboxId);
			await t.run(async (ctx) => {
				await ctx.db.patch(first._id, {
					category: { label: 'notification', source: 'llm', classifiedAt: 1 },
				});
			});

			await ingest(t, seeded, { uid: 2, subject: 'Re: Friday plans?', inReplyTo: 1 });

			const thread = await onlyThread(t, seeded.mailboxId);
			expect(thread.category).toEqual({ label: 'notification', source: 'llm', classifiedAt: 1 });
			expect(await categoryJobs(t)).toHaveLength(2);
		});
	});

	it('resets a standing LLM spam label so the follow-up is filed again', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1 });
			const first = await onlyThread(t, seeded.mailboxId);
			await t.run(async (ctx) => {
				await ctx.db.patch(first._id, {
					category: { label: 'spam', source: 'llm', classifiedAt: 1 },
				});
			});

			await ingest(t, seeded, { uid: 2, subject: 'Re: Friday plans?', inReplyTo: 1 });

			const thread = await onlyThread(t, seeded.mailboxId);
			expect(thread.category).toMatchObject({ label: 'other', source: 'heuristic' });
		});
	});
});

describe('categoryClassify.classifyThread baseline', () => {
	async function llmLabelledThread(t: T): Promise<Id<'mailThreads'>> {
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1 });
		});
		const thread = await onlyThread(t, seeded.mailboxId);
		await t.run(async (ctx) => {
			await ctx.db.patch(thread._id, {
				category: { label: 'notification', source: 'llm', classifiedAt: 1 },
			});
		});
		return thread._id;
	}

	it('skips the baseline write when the scheduling mutation already made it', async () => {
		const t = convexTest(schema, modules);
		const threadId = await llmLabelledThread(t);

		// AI is off by default, so the gate throws and the fail-soft path runs.
		await t.action(internal.mail.ai.categoryClassify.classifyThread, {
			threadId,
			baselineApplied: true,
		});

		const category = await t.run(async (ctx) => (await ctx.db.get(threadId))?.category);
		expect(category).toEqual({ label: 'notification', source: 'llm', classifiedAt: 1 });
	});

	it('still writes the baseline for a job scheduled without the flag', async () => {
		const t = convexTest(schema, modules);
		const threadId = await llmLabelledThread(t);

		await t.action(internal.mail.ai.categoryClassify.classifyThread, { threadId });

		const category = await t.run(async (ctx) => (await ctx.db.get(threadId))?.category);
		expect(category).toMatchObject({ label: 'other', source: 'heuristic' });
	});
});

describe('category on arrival stays off the rest of the thread', () => {
	/** Copies of the thread's one message, `count` of them, older than it and sent by `from`. */
	async function padThread(
		t: T,
		threadId: Id<'mailThreads'>,
		count: number,
		opts: { from: string; newer?: boolean }
	): Promise<void> {
		await t.run(async (ctx) => {
			const [first] = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect();
			const { _id, _creationTime, ...copy } = first!;
			for (let i = 1; i <= count; i++) {
				const offset = opts.newer ? i : -i;
				await ctx.db.insert('mailMessages', {
					...copy,
					fromAddress: opts.from,
					receivedAt: first!.receivedAt + offset * 1000,
				});
			}
			const thread = await ctx.db.get(threadId);
			await ctx.db.patch(threadId, { messageCount: thread!.messageCount + count });
		});
	}

	/** `db` whose `mailMessages` queries count every row they hand back. */
	function countingDb<Db extends object>(db: Db, counter: { rows: number }): Db {
		const wrapQuery = (query: object): object =>
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
								counter.rows += Array.isArray(rows) ? rows.length : rows ? 1 : 0;
								return rows;
							});
						}
						return typeof result === 'object' && result !== null ? wrapQuery(result) : result;
					};
				},
			});
		return new Proxy(db, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (typeof value !== 'function') return value;
				if (prop !== 'query') return (value as (...a: unknown[]) => unknown).bind(target);
				return (table: string) => {
					const query = (value as (t: string) => object).call(target, table);
					return table === 'mailMessages' ? wrapQuery(query) : query;
				};
			},
		});
	}

	it('reads only the newest message of a long thread', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1, subject: 'Your order confirmation' });
		});
		const thread = await onlyThread(t, seeded.mailboxId);
		await padThread(t, thread._id, 60, { from: SENDER });

		const counter = { rows: 0 };
		await withHeldScheduler(async () => {
			await t.run(async (ctx) => {
				await enqueueCategoryCheck({ ...ctx, db: countingDb(ctx.db, counter) }, thread._id);
			});
		});

		expect(counter.rows).toBe(1);
		const after = await onlyThread(t, seeded.mailboxId);
		expect(after.category).toMatchObject({ label: 'receipt', source: 'heuristic' });
	});

	it('hands the thread to the LLM job when the newest rows are all the owner’s', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1, subject: 'Your order confirmation' });
		});
		const thread = await onlyThread(t, seeded.mailboxId);
		await t.run(async (ctx) => {
			await ctx.db.patch(thread._id, { category: undefined });
		});
		await padThread(t, thread._id, ARRIVAL_INBOUND_SCAN, { from: OWNER, newer: true });

		const counter = { rows: 0 };
		await withHeldScheduler(async () => {
			await t.run(async (ctx) => {
				await enqueueCategoryCheck({ ...ctx, db: countingDb(ctx.db, counter) }, thread._id);
			});

			expect(counter.rows).toBe(ARRIVAL_INBOUND_SCAN);
			const after = await onlyThread(t, seeded.mailboxId);
			expect(after.category).toBeUndefined();
			const jobs = await categoryJobs(t);
			expect(jobs).toContainEqual({ threadId: thread._id });
		});
	});

	it('files a long thread as spam from a scheduled job, not inside the delivery', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await withHeldScheduler(async () => {
			await ingest(t, seeded, { uid: 1, subject: 'Your order confirmation' });
		});
		const thread = await onlyThread(t, seeded.mailboxId);
		await padThread(t, thread._id, ARRIVAL_SPAM_MOVE_MAX_MESSAGES, { from: SENDER });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailSenderCategoryOverrides', {
				mailboxId: seeded.mailboxId,
				senderEmail: SENDER,
				label: 'spam',
				updatedAt: Date.now(),
			});
		});
		const folders = async () =>
			await t.run(async (ctx) =>
				(
					await ctx.db
						.query('mailMessages')
						.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
						.collect()
				).map((m) => m.folderId)
			);

		await withHeldScheduler(async () => {
			await t.mutation(internal.mail.categoryArrival.enqueue, { threadId: thread._id });

			expect(new Set(await folders())).toEqual(new Set([seeded.inboxId]));
			const jobs = await t.run(async (ctx) =>
				(await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
					job.name.includes('applyCategory')
				)
			);
			expect(jobs.map((job) => job.args[0])).toEqual([
				{ threadId: thread._id, label: 'spam', source: 'user' },
			]);
		});

		await t.mutation(internal.mail.category.applyCategory, {
			threadId: thread._id,
			label: 'spam',
			source: 'user',
		});
		expect(new Set(await folders())).toEqual(new Set([seeded.spamId]));
	});
});
