/**
 * Draft-on-arrival on an EXTERNAL-account mailbox with `postbox` OFF.
 *
 * `postbox.aiDraft` is declared `requires: ['ai']` +
 * `requiresAny: [['postbox', 'mail.external']]` (adoption-gaps decision D2):
 * the draft pipeline needs *a* mailbox source, either source. This proves the
 * full pipeline end-to-end on an external-only install (the no-domain user):
 *
 *   inbound message on a `kind='external'` mailbox
 *     → deterministic needs-reply verdict (evaluateNeedsReplyCandidate over
 *       the real getThreadContext read)
 *     → applyResult persists the verdict AND schedules
 *       mail/draftOnArrival.generateForThread (the flag gate under test)
 *     → the scheduled Node action runs the REAL shared draft service (only the
 *       LLM seams mocked) and persists the review slot
 *     → the Reply Queue row carries `draftSlot`.
 *
 * The control test flips only `mail.external` off: with neither any-of member
 * ON the resolved flag is forced off, nothing is scheduled, and the queue row
 * renders without a slot — today's behaviour, per D10.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules } from './helpers.testlib';
import { evaluateNeedsReplyCandidate } from '../needsReply';

// ─── Seams: session + LLM only (storage, scheduler, draft service are real) ──

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'user-A',
			role: 'editor' as const,
			activeOrganizationId: 'org-1',
		})),
	};
});

const llm = vi.hoisted(() => ({
	runLlmText: vi.fn(async () => ({
		text: 'EXTERNAL DRAFT BODY',
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	})),
	runLlmObject: vi.fn(async () => ({
		object: { score: 0.72, complete: true, grounded: true, flags: [] },
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	})),
}));
vi.mock('../../lib/llm/dispatch', () => ({
	runLlmText: llm.runLlmText,
	runLlmTextWithTools: llm.runLlmText,
	runLlmObject: llm.runLlmObject,
}));
vi.mock('../../lib/llmProvider', () => ({
	resolveLanguageModel: () => ({}) as never,
	resolveLanguageModelForClassifiedDraft: () => ({}) as never,
}));
vi.mock('../replyOptions', () => ({
	MAX_REPLY_OPTIONS: 3,
	generateReplyOptions: vi.fn(async () => ({
		replies: ['ALT ONE', 'ALT TWO'],
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	})),
}));
vi.mock('../../analytics/llmUsage', () => ({ recordLlmSpend: vi.fn(async () => {}) }));

beforeEach(() => {
	llm.runLlmText.mockClear();
	llm.runLlmObject.mockClear();
});

// ─── Seeding ─────────────────────────────────────────────────────────────────

const OWNER_ADDRESS = 'me@gmail.example';

async function seedInstanceFlags(
	t: TestConvex<typeof schema>,
	featureFlags: FeatureFlagState
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', { featureFlags, createdAt: Date.now() });
	});
}

/** An external-account mailbox (no hosted Postbox row anywhere) with one inbound message. */
async function seedExternalThread(t: TestConvex<typeof schema>): Promise<{
	mailboxId: Id<'mailboxes'>;
	threadId: Id<'mailThreads'>;
	messageId: Id<'mailMessages'>;
}> {
	let mailboxId!: Id<'mailboxes'>;
	let threadId!: Id<'mailThreads'>;
	let messageId!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: OWNER_ADDRESS,
			domain: 'gmail.example',
			kind: 'external',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			uidValidity: now,
			uidNext: 2,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 1,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'friday plans?',
			participants: ['sam@acme.test'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Can you confirm Friday works?',
			latestFromAddress: 'sam@acme.test',
			latestSubject: 'Friday plans?',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m1@acme.test>',
			threadId,
			fromAddress: 'sam@acme.test',
			fromName: 'Sam',
			toAddresses: [OWNER_ADDRESS],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Friday plans?',
			normalizedSubject: 'friday plans?',
			snippet: 'Can you confirm Friday works?',
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
	});
	return { mailboxId, threadId, messageId };
}

/** Verdict + persistence: the real getThreadContext read → the real pure heuristic → applyResult. */
async function detectAndApplyVerdict(
	t: TestConvex<typeof schema>,
	threadId: Id<'mailThreads'>,
	messageId: Id<'mailMessages'>
): Promise<void> {
	const context = await t.query(internal.mail.needsReply.getThreadContext, { threadId });
	expect(context).not.toBeNull();
	const verdict = evaluateNeedsReplyCandidate({
		ownerAddresses: [context!.ownerAddress],
		messages: context!.messages,
	});
	expect(verdict).toEqual({ candidate: true, latestInboundIndex: 0 });
	await t.mutation(internal.mail.needsReply.applyResult, {
		threadId,
		expectedLatestMessageId: context!.latestMessageId,
		needsReply: { messageId, source: 'heuristic', urgency: 'normal' },
	});
}

async function scheduledJobNames(t: TestConvex<typeof schema>): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('draft-on-arrival on an external-only install (postbox=false)', () => {
	it('needs-reply verdict → generateForThread scheduled → draft slot on the Reply Queue row', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		// The no-domain posture: no hosted Postbox, only a connected external
		// account. postbox.aiDraft resolves ON through the mail.external arm of
		// its any-of group.
		await seedInstanceFlags(t, {
			ai: true,
			'mail.external': true,
			postbox: false,
			'postbox.aiDraft': true,
		});
		const { mailboxId, threadId, messageId } = await seedExternalThread(t);

		vi.useFakeTimers();
		try {
			await detectAndApplyVerdict(t, threadId, messageId);

			// The flag gate at needsReply.applyResult scheduled the draft action.
			expect(await scheduledJobNames(t)).toEqual(
				expect.arrayContaining([expect.stringContaining('draftOnArrival')])
			);

			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		// End of the pipeline: the Reply Queue row carries the review slot.
		const queue = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(queue.items).toHaveLength(1);
		const row = queue.items[0]!;
		expect(row.kind).toBe('needs_reply');
		expect(row.draftSlot).toBeDefined();
		expect(row.draftSlot!.draft).toBe('EXTERNAL DRAFT BODY');
		expect(row.draftSlot!.confidence).toBe(0.72);
		// Human-review only: the message was never marked answered by the pipeline.
		await t.run(async (ctx) => {
			expect((await ctx.db.get(messageId))!.flagAnswered).toBe(false);
		});
	});

	it('CONTROL: with mail.external also off, the any-of group forces the flag off — verdict lands, nothing is scheduled', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		// Same stored intent for the draft flag, but no mailbox source at all:
		// requiresAny [['postbox','mail.external']] has no ON member.
		await seedInstanceFlags(t, {
			ai: true,
			'mail.external': false,
			postbox: false,
			'postbox.aiDraft': true,
		});
		const { mailboxId, threadId, messageId } = await seedExternalThread(t);

		vi.useFakeTimers();
		try {
			await detectAndApplyVerdict(t, threadId, messageId);
			expect(await scheduledJobNames(t)).toEqual([]);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		// Today's behaviour: the plain needs-reply row, no pre-generated draft.
		const queue = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(queue.items).toHaveLength(1);
		expect(queue.items[0]!.draftSlot).toBeUndefined();
		expect(llm.runLlmText).not.toHaveBeenCalled();
	});
});
