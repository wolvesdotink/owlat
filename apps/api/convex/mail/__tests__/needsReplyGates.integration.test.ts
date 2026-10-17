/**
 * The Reply Queue classifier's two cheap checks (`mail/ai/needsReplyGates.ts`).
 *
 * L3: the first-time-sender screener runs before the Postbox clarification
 * passes. A sender the screener holds out never costs a clarification call;
 * every other outcome is the one `applyResult` reached before (the held-out
 * thread leaves the queue, a let-in sender is clarified as before).
 *
 * D10: a delivered message that is no reply candidate, and whose only consumer
 * is the reader display, is not interpreted by the run; it waits for the
 * thread to be opened.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { enableFeatures } from '../../__tests__/factories';
import type * as InterpretRun from '../interpret/run';
import type * as LlmProvider from '../../lib/llmProvider';
import type * as Dispatch from '../../lib/llm/dispatch';
import { modules } from './helpers.testlib';
import { captureInterpretSource } from '../interpret/sources';

const runLlmObjectMock = vi.hoisted(() => vi.fn());
const runLlmTextMock = vi.hoisted(() => vi.fn());
const runInterpretationMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProvider>('../../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});
vi.mock('../interpret/run', async () => {
	const actual = await vi.importActual<typeof InterpretRun>('../interpret/run');
	return { ...actual, runInterpretation: runInterpretationMock };
});
vi.mock('../../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof Dispatch>('../../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock, runLlmText: runLlmTextMock };
});

const OWNER = 'me@example.com';
const STRANGER = 'stranger@example.com';
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

beforeEach(() => {
	runInterpretationMock.mockReset();
	runInterpretationMock.mockResolvedValue({
		status: 'complete',
		createdItemIds: [],
		projection: { replyIntent: 'request_for_action', urgency: 'normal', isOnlyTheirs: false },
	});
	runLlmObjectMock.mockReset();
	// The slot pass finds nothing to ask: one call, no clarification.
	runLlmObjectMock.mockResolvedValue({ object: { slots: [] }, tokenUsage: usage, modelUsed: 'm' });
	runLlmTextMock.mockReset();
	runLlmTextMock.mockRejectedValue(new Error('no model in tests'));
});

async function seed(
	t: ReturnType<typeof convexTest>,
	opts: {
		isScreenerOn: boolean;
		senderRow?: { isScreenerAccepted?: boolean };
		sender?: string;
	}
): Promise<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }> {
	const SENDER = opts.sender ?? STRANGER;
	return t.run(async (ctx) => {
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
		const folderId = await ctx.db.insert('mailFolders', {
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
		if (opts.isScreenerOn) {
			await ctx.db.insert('mailUserSettings', {
				userId: 'test-user',
				autoAdvance: 'next',
				isSenderScreenerOn: true,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (opts.senderRow) {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: SENDER,
				useCount: 0,
				lastUsedAt: now,
				createdAt: now,
				...opts.senderRow,
			});
		}
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'question',
			participants: [SENDER, OWNER],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Can you send the report by Friday?',
			latestFromAddress: SENDER,
			latestSubject: 'Question',
			folderRoles: ['inbox'],
			labelIds: [],
			needsReplyPendingAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<q1@example.com>',
			threadId,
			fromAddress: SENDER,
			toAddresses: [OWNER],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Question',
			normalizedSubject: 'question',
			snippet: 'Can you send the report by Friday?',
			rawStorageId: await ctx.storage.store(new Blob(['raw'])),
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
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(threadId, { latestMessageId: messageId });
		return { threadId, messageId };
	});
}

async function classify(opts: Parameters<typeof seed>[1]) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external', 'ai']);
	const { threadId, messageId } = await seed(t, opts);
	await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });
	const thread = await t.run((ctx) => ctx.db.get(threadId));
	return { thread, messageId };
}

describe('L3: the screener runs before Postbox clarification', () => {
	it('a held-out first-time sender costs no clarification call and leaves the queue', async () => {
		const { thread } = await classify({ isScreenerOn: true });
		expect(runInterpretationMock).toHaveBeenCalledTimes(1);
		expect(runLlmObjectMock).not.toHaveBeenCalled();
		expect(runLlmTextMock).not.toHaveBeenCalled();
		// The outcome applyResult always reached for this sender.
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it('an accepted sender is clarified as before', async () => {
		const { thread, messageId } = await classify({
			isScreenerOn: true,
			senderRow: { isScreenerAccepted: true },
		});
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'llm' });
	});

	it('an address-book sender is clarified as before', async () => {
		const { thread, messageId } = await classify({ isScreenerOn: true, senderRow: {} });
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'llm' });
	});

	it('with the screener off (the default) every needs-reply thread is clarified', async () => {
		const { thread, messageId } = await classify({ isScreenerOn: false });
		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'llm' });
	});
});

describe('D10: the classify run defers a display-only non-candidate', () => {
	it('a no-reply notification is not interpreted until the thread is opened', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['mail.external', 'ai']);
		const { threadId, messageId } = await seed(t, {
			isScreenerOn: false,
			sender: 'no-reply@shop.example.com',
		});
		// Delivery captured the eligibility snapshot, outstanding. D10 defers
		// with read on arrival off (with it on, the run reads it now, SPEC §2.1).
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true });
			const message = (await ctx.db.get(messageId))!;
			const userId = (await ctx.db.get(message.mailboxId))!.userId;
			await ctx.db.insert('mailUserSettings', {
				userId,
				autoAdvance: 'next',
				isReadOnArrival: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, {
			threadId,
			interpretMessageId: messageId,
		});

		expect(runInterpretationMock).not.toHaveBeenCalled();
		const snapshot = await t.run((ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
				.first()
		);
		expect(snapshot).toMatchObject({ isDeferred: true });
		expect(snapshot?.isOutstanding).toBeUndefined();
	});

	it('a message without a snapshot is interpreted as before', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['mail.external', 'ai']);
		const { threadId, messageId } = await seed(t, {
			isScreenerOn: false,
			sender: 'no-reply@shop.example.com',
		});
		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, {
			threadId,
			interpretMessageId: messageId,
		});
		expect(runInterpretationMock).toHaveBeenCalledTimes(1);
	});
});

describe('read on arrival: clarification waits for the thread to be fully read (Sol r2 F1)', () => {
	it('a thread with gist-only mail is not clarified yet; the classification looks again', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['mail.external', 'ai']);
		const { threadId, messageId } = await seed(t, { isScreenerOn: false });
		// An earlier message of the thread read only as a gist (upgradeable).
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true });
			const row = (await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
				.first())!;
			await ctx.db.patch(row._id, {
				readOutcome: 'gist',
				isUpgradeable: true,
				sourceOrderKey: '0',
			});
		});
		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });
		expect(runLlmObjectMock).not.toHaveBeenCalled();
		const jobs = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect())
				.filter((job) => job.state.kind === 'pending')
				.map((job) => ({ name: job.name, args: job.args[0] as Record<string, unknown> }))
		);
		expect(jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: expect.stringContaining('needsReplyClassify:classifyThread'),
					args: expect.objectContaining({ fullReadWaits: 1 }),
				}),
				expect.objectContaining({
					name: expect.stringContaining('interpretMessage'),
					args: expect.objectContaining({ depth: 'full', isUpgrade: true }),
				}),
			])
		);
		// Still pending: the verdict waits for the full read.
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.needsReplyPendingAt).toEqual(
			expect.any(Number)
		);
	});
});
