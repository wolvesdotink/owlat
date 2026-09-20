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
 *       mail/ai/draftOnArrival.generateForThread (the flag gate under test)
 *     → the scheduled Node action runs the REAL shared draft service (only the
 *       LLM seams mocked) and persists the review slot
 *     → the Reply Queue row carries `draftSlot`.
 *
 * The control test flips only `mail.external` off: with neither any-of member
 * ON the resolved flag is forced off, nothing is scheduled, and the queue row
 * renders without a slot — today's behaviour, per D10.
 *
 * The third case starts one step earlier, at the IMAP-sync ingest itself, on a
 * SHARED (team) inbox: forward sync enqueues the classifier, and the screener
 * preference of the admin who happens to own the account row is NOT consulted
 * for a mailbox that belongs to a team.
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
	// One object per structured call, carrying BOTH shapes the pipeline asks
	// for: the draft service's verification verdict (score/complete/grounded)
	// and the needs-reply refinement (needsReply/urgency/…), which the shared
	// ingest → classify case below runs through. Each caller reads only its own
	// keys, and the zod schemas are never applied to a mocked return.
	runLlmObject: vi.fn(async () => ({
		object: {
			score: 0.72,
			complete: true,
			grounded: true,
			flags: [],
			needsReply: true,
			urgency: 'normal',
			askSummary: 'Confirm Friday.',
			dueHint: null,
			meetingIntent: null,
		},
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

/**
 * A SHARED external mailbox with its account row + system folders, ready for an
 * `ingestExternalMessage` call (no thread/message seeded — the ingest creates
 * them, exactly as the mail-sync worker does).
 */
async function seedSharedExternalAccount(t: TestConvex<typeof schema>): Promise<{
	mailboxId: Id<'mailboxes'>;
	accountId: Id<'externalMailAccounts'>;
}> {
	let mailboxId!: Id<'mailboxes'>;
	let accountId!: Id<'externalMailAccounts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A', // the admin who connected it — NOT "the owner" of a team inbox
			organizationId: 'org-1',
			address: OWNER_ADDRESS,
			domain: 'gmail.example',
			kind: 'external',
			scope: 'shared',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		for (const role of ['inbox', 'archive'] as const) {
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
		}
		accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			scope: 'shared',
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: OWNER_ADDRESS,
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId });
	});
	return { mailboxId, accountId };
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

		// Today's behaviour: the plain needs-reply flag on the thread, no
		// pre-generated draft. Read it off the thread rather than through
		// `needsReply.listQueue`: with neither mail flag on, the mailbox gate
		// reports `feature_off` and every Postbox read soft-fails to empty, which
		// is the point of this instance shape and not what this case is asserting.
		await t.run(async (ctx) => {
			const thread = (await ctx.db.get(threadId))!;
			expect(thread.needsReply).toBeDefined();
			expect(thread.needsReply!.draftSlot).toBeUndefined();
		});
		expect(llm.runLlmText).not.toHaveBeenCalled();
	});

	// Gap 1 end-to-end on a TEAM inbox, starting at the worker's ingest:
	//   ingestExternalMessage(origin: 'sync', INBOX)
	//     → enqueueNeedsReplyCheck + enqueueCategoryCheck
	//     → the real classify action → applyResult → draft slot.
	// The admin who connected the account has the HEY-style sender screener ON.
	// On a PERSONAL mailbox that setting holds an unknown first-time sender out
	// of the queue entirely; on a shared mailbox it is not consulted at all, so
	// one person's preference can never silence the whole team's queue.
	it('SHARED inbox: forward IMAP sync → classify → draft slot, with the connecting admin screener ON and bypassed', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seedInstanceFlags(t, {
			ai: true,
			'mail.external': true,
			postbox: false,
			'postbox.aiDraft': true,
		});
		const { mailboxId, accountId } = await seedSharedExternalAccount(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				isSenderScreenerOn: true,
				createdAt: now,
				updatedAt: now,
			});
		});

		vi.useFakeTimers();
		try {
			const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
			await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
				accountId,
				folderRole: 'inbox',
				remoteName: 'INBOX',
				remoteUid: 42,
				remoteUidValidity: 7,
				rawStorageId,
				rawSize: 3,
				from: 'Sam <sam@acme.test>',
				to: [OWNER_ADDRESS],
				cc: [],
				bcc: [],
				subject: 'Friday plans?',
				textBodyInline: 'Can you confirm Friday works?',
				messageId: '<m1@acme.test>',
				receivedAt: Date.now(),
				attachments: [],
				origin: 'sync',
			});

			// The ingest itself enqueued the classification (the Gap 1 wiring).
			expect(await scheduledJobNames(t)).toEqual(
				expect.arrayContaining([expect.stringContaining('needsReplyClassify')])
			);

			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		// Screener bypassed (it would have returned null and left no row at all),
		// and the whole pipeline ran through to the pre-generated draft.
		const queue = await t.query(api.mail.needsReply.listQueue, { mailboxId });
		expect(queue.items).toHaveLength(1);
		expect(queue.items[0]!.draftSlot?.draft).toBe('EXTERNAL DRAFT BODY');
	});
});
