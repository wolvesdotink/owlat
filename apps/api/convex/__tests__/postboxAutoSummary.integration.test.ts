/**
 * Cached thread-summary layer (mail/ai/assist.getOrGenerateThreadSummary +
 * mail/ai/summaryCache.ts) with the LLM dispatch seam MOCKED (no real model call):
 *
 *   - a warm cache whose messageCount matches the live thread is served WITHOUT
 *     a dispatch call
 *   - a cold/stale cache regenerates on the cheap tier and PERSISTS the result
 *     on the thread so the next open is warm
 *   - a dispatch failure returns null and caches NOTHING (fail-soft strip)
 *
 * The thread body is framed as untrusted DATA behind the SYSTEM_GUARD.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

// Hoisted so the vi.mock factory below can reference it.
const runLlmTextMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmText: runLlmTextMock };
});

// AWS-SDK / heavy node-only modules aren't on the path under test; drop them.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing')
	)
);

beforeEach(() => {
	runLlmTextMock.mockReset();
});

const OWNER = 'me@example.com';

async function seedMailbox(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: OWNER,
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		return mailboxId;
	});
}

/** Seed a thread with `count` inbound messages; returns thread + latest id. */
async function seedThread(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	count: number
): Promise<{ threadId: Id<'mailThreads'>; latestMessageId: Id<'mailMessages'> }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'question',
			participants: ['alice@example.com', OWNER],
			messageCount: count,
			unreadCount: count,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'hello',
			latestFromAddress: 'alice@example.com',
			latestSubject: 'Question',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		let latestMessageId!: Id<'mailMessages'>;
		for (let i = 0; i < count; i++) {
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			latestMessageId = await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: folder!._id,
				uid: i + 1,
				modseq: i + 1,
				rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
				threadId,
				fromAddress: 'alice@example.com',
				toAddresses: [OWNER],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Question',
				normalizedSubject: 'question',
				snippet: 'hello',
				textBodyInline: 'Please send the report by Friday.',
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
				receivedAt: now + i,
				internalDate: now + i,
				createdAt: now,
				updatedAt: now,
			});
		}
		await ctx.db.patch(threadId, { latestMessageId });
		return { threadId, latestMessageId };
	});
}

async function getThread(
	t: TestConvex<typeof schema>,
	threadId: Id<'mailThreads'>
): Promise<Doc<'mailThreads'> | null> {
	return await t.run(async (ctx) => ctx.db.get(threadId));
}

describe('mail.ai.getOrGenerateThreadSummary', () => {
	it('serves a warm cache (matching messageCount) without a dispatch call', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailbox(t);
		const { threadId, latestMessageId } = await seedThread(t, mailboxId, 5);
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				summaryCache: {
					summary: '- Cached point one\n- Cached point two',
					messageCount: 5,
					generatedAt: 1000,
				},
			});
		});

		const res = await t.action(api.mail.ai.assist.getOrGenerateThreadSummary, {
			messageId: latestMessageId,
		});

		expect(res).toEqual({
			summary: '- Cached point one\n- Cached point two',
			messageCount: 5,
			generatedAt: 1000,
		});
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});

	it('regenerates on a cold cache and persists the result', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailbox(t);
		const { threadId, latestMessageId } = await seedThread(t, mailboxId, 5);

		runLlmTextMock.mockResolvedValue({
			text: '- Fresh point one\n- Fresh point two',
			tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			modelUsed: 'test-model',
		});

		const res = await t.action(api.mail.ai.assist.getOrGenerateThreadSummary, {
			messageId: latestMessageId,
		});

		expect(res?.summary).toBe('- Fresh point one\n- Fresh point two');
		expect(res?.messageCount).toBe(5);
		expect(runLlmTextMock).toHaveBeenCalledTimes(1);
		// The thread body was framed as untrusted data behind the guard.
		expect(runLlmTextMock.mock.calls[0]?.[0]?.system).toContain('untrusted DATA');

		const thread = await getThread(t, threadId);
		expect(thread?.summaryCache).toMatchObject({
			summary: '- Fresh point one\n- Fresh point two',
			messageCount: 5,
		});
	});

	it('regenerates when the cache is stale (messageCount mismatch)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailbox(t);
		const { threadId, latestMessageId } = await seedThread(t, mailboxId, 5);
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				summaryCache: { summary: 'stale', messageCount: 3, generatedAt: 1 },
			});
		});

		runLlmTextMock.mockResolvedValue({
			text: '- Regenerated',
			tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			modelUsed: 'test-model',
		});

		const res = await t.action(api.mail.ai.assist.getOrGenerateThreadSummary, {
			messageId: latestMessageId,
		});

		expect(res?.summary).toBe('- Regenerated');
		expect(runLlmTextMock).toHaveBeenCalledTimes(1);
	});

	it('dispatches under the interactive deadline and schedules the spend write (plan 1.14)', async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['mail.external']);
			rateLimiterTest.register(t);
			await enableFeatures(t, ['ai']);
			const mailboxId = await seedMailbox(t);
			const { latestMessageId } = await seedThread(t, mailboxId, 5);
			const timeout = vi.spyOn(AbortSignal, 'timeout');
			runLlmTextMock.mockResolvedValue({
				text: '- Point',
				tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				modelUsed: 'test-model',
			});

			await t.action(api.mail.ai.assist.getOrGenerateThreadSummary, {
				messageId: latestMessageId,
			});

			const dispatched = runLlmTextMock.mock.calls[0]?.[0];
			expect(dispatched?.maxAttempts).toBe(2);
			expect(dispatched?.abortSignal).toBeInstanceOf(AbortSignal);
			expect(timeout).toHaveBeenCalledWith(20_000);
			timeout.mockRestore();
			// The ledger row is written by a scheduled mutation, not inline.
			const rowsBefore = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
			expect(rowsBefore).toHaveLength(0);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			const rows = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
			expect(rows.map((row) => row.feature)).toEqual(['postbox_summarize']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives the inline completion the short 4 s deadline (plan 1.14)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		runLlmTextMock.mockResolvedValue({ text: ' will do.', tokenUsage: undefined, modelUsed: 'm' });
		try {
			const res = await t.action(api.mail.ai.assist.completeDraft, {
				threadContext: '',
				draftSoFar: 'Thanks, I',
				cursorSentence: 'Thanks, I',
			});
			expect(res.completion).toBe(' will do.');
			expect(timeout).toHaveBeenCalledWith(4_000);
			expect(runLlmTextMock.mock.calls[0]?.[0]?.maxAttempts).toBe(2);
		} finally {
			timeout.mockRestore();
		}
	});

	it('the gate still decides when it runs beside the thread read', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		// `ai` stays off: the gate must reject even though the thread read succeeds.
		const mailboxId = await seedMailbox(t);
		const { latestMessageId } = await seedThread(t, mailboxId, 5);

		await expect(
			t.action(api.mail.ai.assist.getOrGenerateThreadSummary, { messageId: latestMessageId })
		).rejects.toThrow(/disabled/i);
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});

	it('returns null and caches nothing when the dispatch throws (fail-soft)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailbox(t);
		const { threadId, latestMessageId } = await seedThread(t, mailboxId, 5);

		runLlmTextMock.mockRejectedValue(new Error('llm boom'));

		const res = await t.action(api.mail.ai.assist.getOrGenerateThreadSummary, {
			messageId: latestMessageId,
		});

		expect(res).toBeNull();
		const thread = await getThread(t, threadId);
		expect(thread?.summaryCache).toBeUndefined();
	});
});

describe('mail.summaryCache.getThreadSummary', () => {
	it('returns a fresh cache and null for a stale one', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		const mailboxId = await seedMailbox(t);
		const { threadId, latestMessageId } = await seedThread(t, mailboxId, 5);

		// No cache yet → null.
		expect(
			await t.query(api.mail.ai.summaryCache.getThreadSummary, { messageId: latestMessageId })
		).toBeNull();

		// Fresh cache → served.
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				summaryCache: { summary: 'fresh', messageCount: 5, generatedAt: 42 },
			});
		});
		expect(
			await t.query(api.mail.ai.summaryCache.getThreadSummary, { messageId: latestMessageId })
		).toEqual({ summary: 'fresh', messageCount: 5, generatedAt: 42 });

		// Stale cache (count mismatch) → null.
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				summaryCache: { summary: 'stale', messageCount: 3, generatedAt: 42 },
			});
		});
		expect(
			await t.query(api.mail.ai.summaryCache.getThreadSummary, { messageId: latestMessageId })
		).toBeNull();
	});
});
