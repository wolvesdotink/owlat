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
