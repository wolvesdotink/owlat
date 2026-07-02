/**
 * Reply Queue needs-reply detection — persistence + clearing paths, with the
 * LLM dispatch seam MOCKED (no real model call):
 *
 *   - classifyThread persists the LLM-refined result (source `llm`, urgency,
 *     capped askSummary, ISO dueHint) on the thread when the model says yes
 *   - the model saying "no" clears the flag (candidate demoted)
 *   - a dispatch throw leaves the deterministic candidate flag
 *     (source `heuristic`, urgency `normal`, no askSummary) — fail-soft
 *   - `ai` feature flag off → deterministic flag persists, dispatch never runs
 *   - a non-candidate (no-reply sender) clears flag + pending, no LLM call
 *   - any outbound send in the thread clears the flag (draftLifecycle → sent)
 *   - trashing the thread's messages clears the flag (messageActions.trash)
 *   - the manual `clear` mutation clears the flag
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
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

// Hoisted so the vi.mock factories below can reference it.
const runLlmObjectMock = vi.hoisted(() => vi.fn());

// Stub the model resolver so the action needs no LLM key, and the object
// dispatch so we control the refinement result.
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, getLLMProvider: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

// AWS-SDK / heavy node-only modules aren't on the path under test; drop them.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing'),
	),
);

beforeEach(() => {
	runLlmObjectMock.mockReset();
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
	} = {},
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
	threadId: Id<'mailThreads'>,
): Promise<Doc<'mailThreads'> | null> {
	return await t.run(async (ctx) => ctx.db.get(threadId));
}

async function setNeedsReply(
	t: ReturnType<typeof convexTest>,
	threadId: Id<'mailThreads'>,
	messageId: Id<'mailMessages'>,
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

describe('mail.needsReplyClassify.classifyThread', () => {
	it('persists the LLM-refined result on the thread', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		runLlmObjectMock.mockResolvedValue({
			object: {
				needsReply: true,
				urgency: 'high',
				askSummary: 'Send the report',
				dueHint: '2026-07-04',
			},
			tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			modelUsed: 'test-model',
		});

		await t.action(internal.mail.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({
			messageId,
			source: 'llm',
			urgency: 'high',
			askSummary: 'Send the report',
			dueHint: '2026-07-04',
		});
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		// The thread body was framed as data behind the injection guard.
		expect(runLlmObjectMock.mock.calls[0]?.[0]?.prompt).toContain('untrusted DATA');
	});

	it('clears the flag when the LLM demotes the candidate (needsReply: false)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		runLlmObjectMock.mockResolvedValue({
			object: { needsReply: false, urgency: 'low', askSummary: null, dueHint: null },
			tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			modelUsed: 'test-model',
		});

		await t.action(internal.mail.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it('falls back to the deterministic candidate when the LLM dispatch throws', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		runLlmObjectMock.mockRejectedValue(new Error('llm boom'));

		await t.action(internal.mail.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({
			messageId,
			source: 'heuristic',
			urgency: 'normal',
		});
		expect(thread?.needsReply?.askSummary).toBeUndefined();
		expect(thread?.needsReply?.dueHint).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
	});

	it('keeps the deterministic candidate and never calls the LLM when `ai` is off', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		// No enableFeatures → aiGate throws → fail-soft to the heuristic flag.
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});

		await t.action(internal.mail.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toMatchObject({ messageId, source: 'heuristic' });
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('clears flag + pending for a no-reply sender without any LLM call', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded, {
			fromAddress: 'no-reply@shop.example',
			needsReplyPendingAt: Date.now(),
		});
		await setNeedsReply(t, threadId, messageId); // stale flag from before

		await t.action(internal.mail.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(thread?.needsReplyPendingAt).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('does not flag when the owner is only Cc-ed', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId } = await seedThreadWithMessage(t, seeded, {
			toAddresses: ['other@example.com'],
			ccAddresses: [OWNER],
			needsReplyPendingAt: Date.now(),
		});

		await t.action(internal.mail.needsReplyClassify.classifyThread, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});
});

// ─── Clearing paths ──────────────────────────────────────────────────────────

describe('needs-reply clearing', () => {
	it('clears on outbound send in the thread (draftLifecycle → sent)', async () => {
		const t = convexTest(schema, modules);
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
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		await t.mutation(api.mail.messageActions.trash, { messageIds: [messageId] });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
	});

	it('clears via the manual clear mutation', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedThreadWithMessage(t, seeded);
		await setNeedsReply(t, threadId, messageId);

		await t.mutation(api.mail.needsReply.clear, { threadId });

		const thread = await getThread(t, threadId);
		expect(thread?.needsReply).toBeUndefined();
	});
});

// ─── Reconcile sweep ─────────────────────────────────────────────────────────

describe('mail.needsReply.sweepPending', () => {
	it('re-schedules only stale pending threads and bumps their marker', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedMailbox(t);
		const staleAt = Date.now() - 10 * 60 * 1000;
		const { threadId: staleThread } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: staleAt,
		});
		const { threadId: freshThread } = await seedThreadWithMessage(t, seeded, {
			needsReplyPendingAt: Date.now(),
		});
		const { threadId: idleThread } = await seedThreadWithMessage(t, seeded);

		// Freeze timers so the re-scheduled classify action cannot fire (and
		// clear the pending marker) before the assertions below run.
		vi.useFakeTimers();
		try {
			const result = await t.mutation(internal.mail.needsReply.sweepPending, {});
			expect(result.rescheduled).toBe(1);

			const stale = await getThread(t, staleThread);
			expect(stale?.needsReplyPendingAt).toBeGreaterThan(staleAt);
			const fresh = await getThread(t, freshThread);
			expect(fresh?.needsReplyPendingAt).toBeDefined();
			const idle = await getThread(t, idleThread);
			expect(idle?.needsReplyPendingAt).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
