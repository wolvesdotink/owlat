/**
 * Reply Queue needs-reply detection — persistence + clearing paths, with the
 * interpretation run (`runInterpretation`) and the LLM dispatch seam (the
 * clarification passes) MOCKED (no real model call):
 *
 *   - classifyThread persists the interpretation's projection (source `llm`,
 *     urgency, capped askSummary, ISO dueHint) when the server's decision says
 *     a reply is needed
 *   - every item being someone else's clears the flag (candidate demoted)
 *   - a failed / skipped / vanished interpretation leaves the deterministic
 *     candidate flag (source `heuristic`, urgency `normal`) — fail-soft
 *   - `ai` feature flag off → no clarification pass
 *   - a non-candidate (no-reply sender) clears flag + pending, no LLM call
 *   - any outbound send in the thread clears the flag (draftLifecycle → sent)
 *   - trashing the thread's messages clears the flag (messageActions.trash)
 *   - the manual `clear` mutation clears the flag
 *
 * Plus the Reply Queue read side (`listQueue`): flagged threads are returned
 * joined with the trigger message, snoozed trigger messages are hidden, a
 * missing trigger message drops only its row, and anonymous / non-owner
 * callers get an empty list (soft-auth).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { normalizeQuestionKey } from '../inbox/clarificationMemoryMatch';
import { MAX_SWEEP_RETRIES, SWEEP_MIN_AGE_MS } from '../mail/needsReplyPending';
import type * as InterpretRun from '../mail/interpret/run';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

// Hoisted so the vi.mock factories below can reference it.
const runLlmObjectMock = vi.hoisted(() => vi.fn());
// The interpretation run the classifier reads its verdict from.
const runInterpretationMock = vi.hoisted(() => vi.fn());
// Candidate replies for the clarification divergence check. Rejects unless a
// test queues replies, which is what the real dispatcher does without a key.
const runLlmTextMock = vi.hoisted(() => vi.fn());

// Stub the model resolver so the action needs no LLM key, and the object
// dispatch so we control the refinement result.
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});

vi.mock('../mail/interpret/run', async () => {
	const actual = await vi.importActual<typeof InterpretRun>('../mail/interpret/run');
	return { ...actual, runInterpretation: runInterpretationMock };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock, runLlmText: runLlmTextMock };
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
	runInterpretationMock.mockReset();
	runInterpretationMock.mockResolvedValue({ status: 'failed', createdItemIds: [], errorCode: 'x' });
	runLlmObjectMock.mockReset();
	runLlmTextMock.mockReset();
	runLlmTextMock.mockRejectedValue(new Error('no model in tests'));
});

// ─── Seed helpers ────────────────────────────────────────────────────────────

const OWNER = 'me@example.com';

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	sentId: Id<'mailFolders'>;
	trashId: Id<'mailFolders'>;
}

async function seedMailbox(t: ReturnType<typeof convexTest>): Promise<Seeded> {
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
		const folder = (name: string, role: string) =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 0,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		const inboxId = await folder('INBOX', 'inbox');
		const sentId = await folder('Sent', 'sent');
		const trashId = await folder('Trash', 'trash');
		return { mailboxId, inboxId, sentId, trashId };
	});
}

async function seedThreadWithMessage(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	overrides: {
		fromAddress?: string;
		toAddresses?: string[];
		ccAddresses?: string[];
		needsReplyPendingAt?: number;
	} = {}
): Promise<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const from = overrides.fromAddress ?? 'alice@example.com';
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: 'question',
			participants: [from, OWNER],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Can you send the report by Friday?',
			latestFromAddress: from,
			latestSubject: 'Question',
			folderRoles: ['inbox'],
			labelIds: [],
			needsReplyPendingAt: overrides.needsReplyPendingAt,
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId: seeded.mailboxId,
			folderId: seeded.inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
			threadId,
			fromAddress: from,
			toAddresses: overrides.toAddresses ?? [OWNER],
			ccAddresses: overrides.ccAddresses ?? [],
			bccAddresses: [],
			subject: 'Question',
			normalizedSubject: 'question',
			snippet: 'Can you send the report by Friday?',
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
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(threadId, { latestMessageId: messageId });
		return { threadId, messageId };
	});
}

async function getThread(
	t: ReturnType<typeof convexTest>,
	threadId: Id<'mailThreads'>
): Promise<Doc<'mailThreads'> | null> {
	return await t.run(async (ctx) => ctx.db.get(threadId));
}

async function setNeedsReply(
	t: ReturnType<typeof convexTest>,
	threadId: Id<'mailThreads'>,
	messageId: Id<'mailMessages'>
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.patch(threadId, {
			needsReply: {
				messageId,
				detectedAt: Date.now(),
				source: 'heuristic' as const,
				urgency: 'normal' as const,
			},
		});
	});
}

// ─── classifyThread ──────────────────────────────────────────────────────────

/** A run that read the message and projected these needs-reply inputs. */
function interpreted(
	projection: Partial<{
		replyIntent: string;
		urgency: 'high' | 'normal' | 'low';
		askSummary: string;
		dueHint: string;
		isOnlyTheirs: boolean;
	}> = {}
) {
	runInterpretationMock.mockResolvedValueOnce({
		status: 'complete',
		createdItemIds: [],
		projection: {
			replyIntent: 'request_for_action',
			urgency: 'normal',
			isOnlyTheirs: false,
			...projection,
		},
	});
}

describe('mail.needsReplyClassify.classifyThread', () => {
	it('keeps a memory-filled question on the card, pre-picked as a memory answer', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		const dock = 'Which loading dock should they use?';
		await t.run(async (ctx) => {
			const now = Date.now();
			// Org-general standing answer: fills for any sender.
			await ctx.db.insert('clarificationMemory', {
				slotType: 'factual_lookup',
				questionKey: normalizeQuestionKey('factual_lookup', dock),
				questionText: dock,
				answerValue: 'Bay 3',
				source: 'reply_queue',
				answerCount: 2,
				useCount: 0,
				createdAt: now,
				updatedAt: now,
			});
		});

		const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
		const slot = (slotType: string, question: string) => ({
			slotType,
			question,
			answerableFromContext: false,
			decisionRelevant: true,
			options: [],
		});
		interpreted({ askSummary: 'Delivery details' });
		runLlmObjectMock
			.mockResolvedValueOnce({
				object: {
					slots: [slot('factual_lookup', dock), slot('date_time', 'When can we deliver?')],
				},
				tokenUsage: usage,
				modelUsed: 'test-model',
			})
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [0, 1] },
				tokenUsage: usage,
				modelUsed: 'test-model',
			})
			.mockResolvedValueOnce({ object: { translations: [] }, tokenUsage: usage, modelUsed: 'm' });
		runLlmTextMock
			.mockResolvedValueOnce({ text: 'Bay 1, Monday.', tokenUsage: usage, modelUsed: 'm' })
			.mockResolvedValueOnce({ text: 'Bay 3, Friday.', tokenUsage: usage, modelUsed: 'm' });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const clarification = (await getThread(t, threadId))?.needsReply?.clarification;
		expect(clarification?.isNeeded).toBe(true);
		expect(clarification?.questions).toEqual([
			expect.objectContaining({
				text: dock,
				answerKind: 'text',
				answer: expect.objectContaining({ value: 'Bay 3', source: 'memory' }),
			}),
			expect.objectContaining({ text: 'When can we deliver?', answerKind: 'date' }),
		]);
		expect(clarification?.questions[1]?.answer).toBeUndefined();
	});

	it('persists the LLM-refined result on the thread', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		interpreted({ urgency: 'high', askSummary: 'Send the report', dueHint: '2026-07-04' });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({
			messageId,
			source: 'llm',
			urgency: 'high',
			askSummary: 'Send the report',
			dueHint: '2026-07-04',
		});
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		// The newest inbound message is what gets interpreted, as live mail.
		expect(runInterpretationMock).toHaveBeenCalledTimes(1);
		expect(runInterpretationMock.mock.calls[0]?.[1]).toEqual({
			source: { kind: 'mail', id: messageId },
			isLive: true,
		});
	});

	it('uses the stored projection of a replayed run (the sweep re-classifying)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		runInterpretationMock.mockResolvedValueOnce({
			status: 'replayed',
			createdItemIds: [],
			projection: { replyIntent: 'direct_question', urgency: 'low', isOnlyTheirs: false },
		});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'llm', urgency: 'low' });
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it("clears the flag when every item is someone else's", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		interpreted({ replyIntent: 'direct_question', urgency: 'low', isOnlyTheirs: true });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it('clears the flag for a recap, whatever items it carries', async () => {
		// The meeting-notes bug end to end: the run extracts the to-do bullets as
		// items the reader owns, but it named the message informational_update
		// and the intent has the final say (mail/ai/replyIntent.ts). An
		// actionable item alone never implies a reply.
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		await setNeedsReply(t, threadId, messageId); // stale flag from before

		interpreted({ replyIntent: 'informational_update', askSummary: 'Confirm the action items' });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		// No reply needed → no clarification passes.
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('clears flag + pending for machine-generated mail without any LLM call', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		await setNeedsReply(t, threadId, messageId); // stale flag from before

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, {
			threadId,
			autoSubmitted: 'auto-generated',
		});

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
		expect(runInterpretationMock).not.toHaveBeenCalled();
	});

	it('still interprets the delivered message of a non-candidate thread (once)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, {
			threadId,
			autoSubmitted: 'auto-generated',
			precedence: 'list',
			listId: '<news.example.com>',
			interpretMessageId: messageId,
		});

		expect((await getThread(t, threadId))?.needsReply).toBeUndefined();
		expect(runInterpretationMock).toHaveBeenCalledTimes(1);
		expect(runInterpretationMock.mock.calls[0]?.[1]).toEqual({
			source: { kind: 'mail', id: messageId },
			isLive: true,
			precedence: 'list',
			listId: '<news.example.com>',
		});
	});

	it('interprets the delivered message once when it is the candidate', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		interpreted({ replyIntent: 'informational_update' });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, {
			threadId,
			interpretMessageId: messageId,
		});

		expect(runInterpretationMock).toHaveBeenCalledTimes(1);
		expect(runInterpretationMock.mock.calls[0]?.[1]?.source).toEqual({
			kind: 'mail',
			id: messageId,
		});
	});

	it('falls back to the deterministic candidate when the LLM dispatch throws', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		runInterpretationMock.mockResolvedValueOnce({
			status: 'failed',
			createdItemIds: [],
			errorCode: 'model_error',
		});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({
			messageId,
			source: 'heuristic',
			urgency: 'normal',
		});
		expect(thread?.needsReply?.askSummary).toBeUndefined();
		expect(thread?.needsReply?.dueHint).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	for (const run of [
		{ status: 'skipped', createdItemIds: [], errorCode: 'bulk_stranger' },
		{ status: 'gone' },
		// A failed run that still carried a projection is not a verdict either.
		{
			status: 'failed',
			createdItemIds: [],
			errorCode: 'stale',
			projection: { replyIntent: 'direct_question', urgency: 'high', isOnlyTheirs: false },
		},
	]) {
		it(`keeps the baseline when the interpretation is ${run.status}`, async () => {
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const seeded = await seedMailbox(t);
			const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
				needsReplyPendingAt: Date.now(),
			});
			runInterpretationMock.mockResolvedValueOnce(run);

			await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

			const thread = await getThread(t, threadId);
			expect(thread?.needsReply).toMatchObject({ messageId, source: 'heuristic' });
			expect(thread?.needsReplyPendingAt).toBeUndefined();
		});
	}

	it('keeps the deterministic candidate when interpretation is refused (`ai` off)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		runInterpretationMock.mockResolvedValueOnce({
			status: 'failed',
			createdItemIds: [],
			errorCode: 'ai_off',
		});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'heuristic' });
		expect(runLlmObjectMock).not.toHaveBeenCalled();
		// A refusal would only repeat: the run settles instead of waiting for the sweep.
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it('skips the clarification passes behind the Postbox AI gate when `ai` is off', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		// No `ai` flag: the clarification gate refuses, the verdict still lands.
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		interpreted({ askSummary: 'Send the report' });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'llm' });
		expect(thread?.needsReply?.clarification).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	// "Send us the invoices for our four bookings": every sampled reply writes
	// "please find them attached", so a file slot always converges. It is asked
	// anyway, and without paying for the samples when it is the only slot.
	it('asks for a requested file without the divergence check', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
		interpreted({ askSummary: 'Invoices for four bookings' });
		runLlmObjectMock
			.mockResolvedValueOnce({
				object: {
					slots: [
						{
							slotType: 'attachment',
							question: 'Please provide the invoice PDFs for the four bookings',
							answerableFromContext: false,
							// A file request counts whatever the extractor says here.
							decisionRelevant: false,
							options: [],
						},
					],
				},
				tokenUsage: usage,
				modelUsed: 'm',
			})
			.mockResolvedValueOnce({ object: { translations: [] }, tokenUsage: usage, modelUsed: 'm' });

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const clarification = (await getThread(t, threadId))?.needsReply?.clarification;
		expect(clarification?.questions).toEqual([
			expect.objectContaining({
				slotType: 'attachment',
				answerKind: 'file',
				text: 'Please provide the invoice PDFs for the four bookings',
			}),
		]);
		expect(runLlmTextMock).not.toHaveBeenCalled();
	});

	it('keeps the file question when the samples converge on everything', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
		const slot = (slotType: string, question: string) => ({
			slotType,
			question,
			answerableFromContext: false,
			decisionRelevant: true,
			options: [],
		});
		interpreted({ askSummary: 'Invoices' });
		runLlmObjectMock
			.mockResolvedValueOnce({
				object: {
					slots: [
						slot('decision', 'Should the invoices go to the new billing address?'),
						slot('attachment', 'Please provide the invoice PDFs'),
					],
				},
				tokenUsage: usage,
				modelUsed: 'm',
			})
			// The samples agree on the decision: it is a safe assumption.
			.mockResolvedValueOnce({
				object: { divergentSlotIndexes: [] },
				tokenUsage: usage,
				modelUsed: 'm',
			})
			.mockResolvedValueOnce({ object: { translations: [] }, tokenUsage: usage, modelUsed: 'm' });
		runLlmTextMock
			.mockResolvedValueOnce({ text: 'Invoices attached.', tokenUsage: usage, modelUsed: 'm' })
			.mockResolvedValueOnce({
				text: 'Please find them attached.',
				tokenUsage: usage,
				modelUsed: 'm',
			});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const questions = (await getThread(t, threadId))?.needsReply?.clarification?.questions;
		expect(questions?.map((q) => q.text)).toEqual(['Please provide the invoice PDFs']);
		// Only the decision was put to the divergence judge.
		const judgePrompt = runLlmObjectMock.mock.calls[1]?.[0]?.prompt as string;
		expect(judgePrompt).toContain('billing address');
		expect(judgePrompt).not.toContain('invoice PDFs');
	});

	it('clears flag + pending for a no-reply sender without any LLM call', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			fromAddress: 'no-reply@shop.example',
			needsReplyPendingAt: Date.now(),
		});
		await setNeedsReply(t, threadId, messageId); // stale flag from before

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, {
			threadId,
			interpretMessageId: messageId,
		});

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
		// The brief still reads the mail; the unattended sender just gets no queue row.
		expect(runInterpretationMock).toHaveBeenCalledTimes(1);
	});

	it('does not flag when the owner is only Cc-ed', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			toAddresses: ['other@example.com'],
			ccAddresses: [OWNER],
			needsReplyPendingAt: Date.now(),
		});

		await t.action(internal.mail.ai.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});
});

// ─── Clearing paths ──────────────────────────────────────────────────────────

describe('needs-reply clearing', () => {
	it('clears on outbound send in the thread (draftLifecycle → sent)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		const { draftId, rawStorageId } = await t.run(async (ctx) => {
			const now = Date.now();
			const draftId = await ctx.db.insert('mailDrafts', {
				mailboxId: seeded.mailboxId,
				threadId,
				toAddresses: ['alice@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: OWNER,
				subject: 'Re: Question',
				bodyHtml: '<p>On it</p>',
				attachments: [],
				state: 'pending_send' as const,
				lastEditedAt: now,
				createdAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw-out']));
			return { draftId, rawStorageId };
		});

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: {
					rawStorageId,
					rawSize: 7,
					rfc822MessageId: 'reply-msg@example.com',
					references: [],
					bodyHtml: '<p>On it</p>',
					bodyText: 'On it',
					attachmentsMeta: [],
				},
			},
		});
		expect(outcome.ok).toBe(true);

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it('clears when the thread mail is trashed (messageActions.trash)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		await t.mutation(api.mail.messageActions.trash, { messageIds: [messageId] });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
	});

	it('clears via the manual clear mutation', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		await t.mutation(api.mail.needsReply.clear, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
	});
});

// ─── Reply Queue read side ───────────────────────────────────────────────────

describe('mail.needsReply.listQueue', () => {
	it('returns flagged threads joined with the trigger message fields', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				needsReply: {
					messageId,
					detectedAt: Date.now(),
					source: 'llm' as const,
					urgency: 'high' as const,
					askSummary: 'Send the report',
					dueHint: '2026-07-04',
				},
			});
		});

		const { items } = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			threadId,
			messageId,
			urgency: 'high',
			askSummary: 'Send the report',
			dueHint: '2026-07-04',
			source: 'llm',
			fromAddress: 'alice@example.com',
			subject: 'Question',
			snippet: 'Can you send the report by Friday?',
		});
	});

	it('hides a snoozed trigger message and floats it back after wakeup', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		await t.mutation(api.mail.snooze.snooze, {
			messageId,
			until: Date.now() + 60 * 60 * 1000,
		});
		const snoozed = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});
		expect(snoozed.items).toEqual([]);

		// Past the wakeup instant the row is visible again (the cron only
		// restores the folder; visibility here keys off snoozedUntil alone).
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: Date.now() - 1000 });
		});
		const awake = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});
		expect(awake.items.map((i) => i.threadId)).toEqual([threadId]);
	});

	it('drops only the row whose trigger message is gone', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const orphan = await seedThreadWithMessage(t, seeded);
		const intact = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, orphan.threadId, orphan.messageId);
		await setNeedsReply(t, intact.threadId, intact.messageId);
		await t.run(async (ctx) => {
			await ctx.db.delete(orphan.messageId);
		});

		const { items } = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});

		expect(items.map((i) => i.threadId)).toEqual([intact.threadId]);
	});

	it('returns an empty list for an anonymous caller (soft-auth)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValueOnce(null);
		const { items } = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});

		expect(items).toEqual([]);
	});

	it('returns an empty list for an editor who does not own the mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t); // mailbox.userId === 'test-user'
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValueOnce({
			userId: 'other-user',
			role: 'editor',
			activeOrganizationId: 'test-org',
		});
		const { items } = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});

		expect(items).toEqual([]);
	});
});

// ─── Reply Queue count (plan 2.11) ──────────────────────────────────────────

describe('mail.needsReply.countQueue', () => {
	it('counts exactly the rows listQueue returns, follow-ups included', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const visible = await seedThreadWithMessage(t, seeded);
		const snoozed = await seedThreadWithMessage(t, seeded);
		const orphan = await seedThreadWithMessage(t, seeded);
		const muted = await seedThreadWithMessage(t, seeded);
		const followUp = await seedThreadWithMessage(t, seeded, { fromAddress: OWNER });
		for (const row of [visible, snoozed, orphan, muted]) {
			await setNeedsReply(t, row.threadId, row.messageId);
		}
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.patch(snoozed.messageId, { snoozedUntil: now + 60 * 60 * 1000 });
			await ctx.db.delete(orphan.messageId);
			await ctx.db.patch(muted.threadId, { mutedAt: now });
			await ctx.db.patch(followUp.threadId, {
				followUp: {
					messageId: followUp.messageId,
					remindAt: now - 1000,
					armedAt: now - 5000,
					dueAt: now - 1000,
					waitingOn: 'alice@example.com',
				},
			});
		});

		const { items } = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});
		const count = await t.query(api.mail.needsReply.countQueue, {
			mailboxId: seeded.mailboxId,
		});

		expect(items.map((i) => i.threadId).sort()).toEqual(
			[visible.threadId, followUp.threadId].sort()
		);
		expect(count).toBe(items.length);
	});

	it('follows the list as rows are cleared', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);
		expect(await t.query(api.mail.needsReply.countQueue, { mailboxId: seeded.mailboxId })).toBe(1);

		await t.mutation(api.mail.needsReply.clear, { threadId });

		expect(await t.query(api.mail.needsReply.countQueue, { mailboxId: seeded.mailboxId })).toBe(0);
	});

	it('returns 0 for an anonymous caller and for an editor who does not own the mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValueOnce(null);
		expect(await t.query(api.mail.needsReply.countQueue, { mailboxId: seeded.mailboxId })).toBe(0);

		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValueOnce({
			userId: 'other-user',
			role: 'editor',
			activeOrganizationId: 'test-org',
		});
		expect(await t.query(api.mail.needsReply.countQueue, { mailboxId: seeded.mailboxId })).toBe(0);
	});
});

// ─── Reconcile sweep ─────────────────────────────────────────────────────────

describe('mail.needsReplyPending.sweepPending', () => {
	it('re-schedules only stale pending threads and bumps their marker', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const staleAt = Date.now() - 20 * 60 * 1000;
		const { threadId: staleThread } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: staleAt,
		});
		// Still waiting for an action slot, not lost: re-scheduling it would
		// classify (and draft) the thread twice.
		const queuedAt = Date.now() - 8 * 60 * 1000;
		const { threadId: queuedThread } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: queuedAt,
		});
		const { threadId: freshThread } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		const { threadId: idleThread } = await seedThreadWithMessage(t, seeded);

		// Freeze timers so the re-scheduled classify action cannot fire (and
		// clear the pending marker) before the assertions below run.
		vi.useFakeTimers();
		try {
			const result = await t.mutation(internal.mail.needsReplyPending.sweepPending, {});
			expect(result.rescheduled).toBe(1);

			const stale = await getThread(t, staleThread);
			expect(stale?.needsReplyPendingAt).toBeGreaterThan(staleAt);
			const queued = await getThread(t, queuedThread);
			expect(queued?.needsReplyPendingAt).toBe(queuedAt);
			const fresh = await getThread(t, freshThread);
			expect(fresh?.needsReplyPendingAt).toBeDefined();
			const idle = await getThread(t, idleThread);
			expect(idle?.needsReplyPendingAt).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	// The run that died after its baseline (the backend was OOM-killed while the
	// model was answering): the baseline left the thread pending, so the sweep
	// classifies it again instead of leaving a `heuristic` flag for good.
	it('keeps a thread pending after the heuristic baseline and re-schedules it', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now() - 60_000,
		});

		vi.useFakeTimers();
		try {
			await t.mutation(internal.mail.needsReply.applyResult, {
				threadId,
				expectedLatestMessageId: messageId,
				needsReply: { messageId, source: 'heuristic', urgency: 'normal' },
				isBaseline: true,
			});
			const baseline = await getThread(t, threadId);
			expect(baseline?.needsReply?.source).toBe('heuristic');
			expect(baseline?.needsReplyPendingAt).toBeGreaterThanOrEqual(Date.now());

			// Too early: the run may still be going.
			expect((await t.mutation(internal.mail.needsReplyPending.sweepPending, {})).rescheduled).toBe(
				0
			);
			vi.setSystemTime(Date.now() + SWEEP_MIN_AGE_MS + 1000);
			expect((await t.mutation(internal.mail.needsReplyPending.sweepPending, {})).rescheduled).toBe(
				1
			);
			expect((await getThread(t, threadId))?.needsReplyRetryCount).toBe(1);
			const jobs = await t.run(async (ctx) =>
				(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
			);
			expect(jobs).toEqual([expect.stringContaining('needsReplyClassify')]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives up on a thread whose run keeps dying', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now() - SWEEP_MIN_AGE_MS - 1000,
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, { needsReplyRetryCount: MAX_SWEEP_RETRIES });
		});

		vi.useFakeTimers();
		try {
			const result = await t.mutation(internal.mail.needsReplyPending.sweepPending, {});
			expect(result).toEqual({ rescheduled: 0, abandoned: 1 });
			const thread = await getThread(t, threadId);
			expect(thread?.needsReplyPendingAt).toBeUndefined();
			expect(thread?.needsReplyRetryCount).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('mail.needsReplyPending.settlePending', () => {
	it('clears the marker, but not one a newer message stamped', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		const { messageId: otherMessage } = await seedThreadWithMessage(t, seeded);

		// Settled for a message that is no longer the newest: the marker is not its own.
		await t.mutation(internal.mail.needsReplyPending.settlePending, {
			threadId,
			expectedLatestMessageId: otherMessage,
		});
		expect((await getThread(t, threadId))?.needsReplyPendingAt).toBeDefined();

		await t.mutation(internal.mail.needsReplyPending.settlePending, {
			threadId,
			expectedLatestMessageId: messageId,
		});
		expect((await getThread(t, threadId))?.needsReplyPendingAt).toBeUndefined();
	});
});
