/**
 * Daily Brief + bidirectional commitment tracking — persistence paths with the
 * LLM dispatch seam MOCKED (no real model call):
 *
 *   - extractCommitment persists an OUTBOUND commitment (a promise the owner
 *     made in sent mail) with a parsed deadline + counterparty; the `ai` flag
 *     off or a dispatch throw leaves NO commitment row (fail-soft).
 *   - the commitment sweep arms a pre-lapse reminder (reusing mail/followUps.ts)
 *     for an open commitment inside its reminder window and flips it to
 *     `reminded` exactly once — so a user's own promise can't lapse unseen.
 *   - buildDailyBriefs ranks the "needs you" items (a high-priority reply +
 *     an open commitment) above nothing, and bundles low-signal newsletter mail
 *     into the AUDITABLE digest (counts equal the listed entries).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal, api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
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

const runLlmObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, getLLMProvider: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

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
	runLlmObjectMock.mockReset();
});

const OWNER = 'me@example.com';

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	sentId: Id<'mailFolders'>;
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
		return { mailboxId, inboxId, sentId };
	});
}

/** Seed a SENT (owner-outbound) message + its thread. */
async function seedSentMessage(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	opts: { body: string; to?: string } = { body: "I'll send the report Friday" }
): Promise<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const to = opts.to ?? 'alice@example.com';
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: 'report',
			participants: [OWNER, to],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: opts.body,
			latestFromAddress: OWNER,
			latestSubject: 'Report',
			folderRoles: ['sent'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId: seeded.mailboxId,
			folderId: seeded.sentId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
			threadId,
			fromAddress: OWNER,
			toAddresses: [to],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Report',
			normalizedSubject: 'report',
			snippet: opts.body,
			textBodyInline: opts.body,
			rawStorageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: true,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			outbound: { state: 'sent', recipients: [{ idx: 0, address: to, mtaJobId: 'j0', state: 'sent', sentAt: now }] },
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(threadId, { latestMessageId: messageId });
		return { threadId, messageId };
	});
}

// ─── extractCommitment ───────────────────────────────────────────────────────

describe('mail.commitmentExtract.extractCommitment', () => {
	it('persists an outbound commitment from a sent promise', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedSentMessage(t, seeded);

		runLlmObjectMock.mockResolvedValue({
			object: {
				hasCommitment: true,
				description: 'Send the quarterly report',
				dueDate: '2026-07-10',
				duePhrase: 'Friday',
			},
			tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			modelUsed: 'test-model',
		});

		await t.action(internal.mail.commitmentExtract.extractCommitment, {
			messageId,
			direction: 'outbound',
		});

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('mailCommitments')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', seeded.mailboxId))
				.collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			threadId,
			messageId,
			direction: 'outbound',
			description: 'Send the quarterly report',
			counterparty: 'alice@example.com',
			status: 'open',
			source: 'llm',
			dueAt: Date.parse('2026-07-10T23:59:59.999Z'),
			dueHintRaw: 'Friday',
		});
		// The sent body was framed as untrusted data behind the injection guard.
		expect(runLlmObjectMock.mock.calls[0]?.[0]?.prompt).toContain('untrusted DATA');
	});

	it('writes NO commitment when the model finds none (fail-soft)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailbox(t);
		const { messageId } = await seedSentMessage(t, seeded);

		runLlmObjectMock.mockResolvedValue({
			object: { hasCommitment: false, description: null, dueDate: null, duePhrase: null },
			tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			modelUsed: 'test-model',
		});

		await t.action(internal.mail.commitmentExtract.extractCommitment, {
			messageId,
			direction: 'outbound',
		});

		const rows = await t.run(async (ctx) => ctx.db.query('mailCommitments').collect());
		expect(rows).toHaveLength(0);
	});

	it('writes NO commitment and never calls the model when AI is disabled', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		// No enableFeatures → `ai` flag off.
		const seeded = await seedMailbox(t);
		const { messageId } = await seedSentMessage(t, seeded);

		await t.action(internal.mail.commitmentExtract.extractCommitment, {
			messageId,
			direction: 'outbound',
		});

		expect(runLlmObjectMock).not.toHaveBeenCalled();
		const rows = await t.run(async (ctx) => ctx.db.query('mailCommitments').collect());
		expect(rows).toHaveLength(0);
	});
});

// ─── commitment sweep (pre-lapse reminder) ───────────────────────────────────

describe('mail.commitments.sweep', () => {
	it('reminds an open commitment before its deadline and arms the follow-up', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		// Sent message whose body makes no promise → Pass 1 will not re-extract it.
		const { threadId, messageId } = await seedSentMessage(t, seeded, {
			body: 'Here is the file.',
		});

		const now = Date.now();
		const commitmentId = await t.run(async (ctx) =>
			ctx.db.insert('mailCommitments', {
				mailboxId: seeded.mailboxId,
				threadId,
				messageId,
				direction: 'outbound',
				description: 'Send the report',
				counterparty: 'alice@example.com',
				dueAt: now + 30 * 60 * 1000, // 30 min out — inside the 1h window
				status: 'open',
				source: 'llm',
				createdAt: now,
				updatedAt: now,
			})
		);

		const res = await t.mutation(internal.mail.commitments.sweep, {});
		expect(res.reminded).toBe(1);

		const commitment = await t.run(async (ctx) => ctx.db.get(commitmentId));
		expect(commitment?.status).toBe('reminded');
		expect(commitment?.remindedAt).toBeGreaterThan(0);

		// The follow-up watch was armed on the thread (reuses mail/followUps.ts),
		// so it will surface in the Reply Queue.
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.followUp?.messageId).toBe(messageId);
		expect(thread?.followUpRemindAt).toBeGreaterThan(0);
	});

	it('does not remind a commitment whose deadline is far out', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		const { threadId, messageId } = await seedSentMessage(t, seeded, { body: 'ok' });

		const now = Date.now();
		await t.run(async (ctx) =>
			ctx.db.insert('mailCommitments', {
				mailboxId: seeded.mailboxId,
				threadId,
				messageId,
				direction: 'outbound',
				description: 'Send the report',
				dueAt: now + 5 * 24 * 60 * 60 * 1000, // 5 days out
				status: 'open',
				source: 'llm',
				createdAt: now,
				updatedAt: now,
			})
		);

		const res = await t.mutation(internal.mail.commitments.sweep, {});
		expect(res.reminded).toBe(0);
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.followUp).toBeUndefined();
	});
});

// ─── buildDailyBriefs ────────────────────────────────────────────────────────

describe('mail.dailyBrief.buildDailyBriefs', () => {
	it('ranks pending items + commitments and bundles low-signal mail auditably', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const seeded = await seedMailbox(t);
		const now = Date.now();

		// A high-priority inbound reply.
		const reply = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId: seeded.mailboxId,
				normalizedSubject: 'urgent',
				participants: ['boss@example.com', OWNER],
				messageCount: 1,
				unreadCount: 1,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'need this today',
				latestFromAddress: 'boss@example.com',
				latestSubject: 'Urgent ask',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['r']));
			const messageId = await ctx.db.insert('mailMessages', {
				mailboxId: seeded.mailboxId,
				folderId: seeded.inboxId,
				uid: 2,
				modseq: 2,
				rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
				threadId,
				fromAddress: 'boss@example.com',
				toAddresses: [OWNER],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Urgent ask',
				normalizedSubject: 'urgent',
				snippet: 'need this today',
				rawStorageId,
				rawSize: 1,
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
			await ctx.db.patch(threadId, {
				latestMessageId: messageId,
				needsReply: {
					messageId,
					detectedAt: now,
					source: 'llm' as const,
					urgency: 'high' as const,
					priorityScore: 96,
					askSummary: 'Deliver the deck',
				},
			});
			return { threadId };
		});

		// A low-signal newsletter thread (bundled).
		const newsletterThread = await t.run(async (ctx) =>
			ctx.db.insert('mailThreads', {
				mailboxId: seeded.mailboxId,
				normalizedSubject: 'weekly digest',
				participants: ['news@brand.com', OWNER],
				messageCount: 1,
				unreadCount: 1,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now - 1000,
				firstMessageAt: now - 1000,
				latestSnippet: 'this week in tech',
				latestFromAddress: 'news@brand.com',
				latestSubject: 'Weekly Digest',
				folderRoles: ['inbox'],
				labelIds: [],
				category: { label: 'newsletter' as const, source: 'heuristic' as const, classifiedAt: now },
				createdAt: now,
				updatedAt: now,
			})
		);

		// An open commitment with a deadline.
		await t.run(async (ctx) =>
			ctx.db.insert('mailCommitments', {
				mailboxId: seeded.mailboxId,
				threadId: reply.threadId,
				messageId: (await ctx.db.get(reply.threadId))!.latestMessageId!,
				direction: 'outbound',
				description: 'Send the signed contract',
				dueAt: now + 2 * 60 * 60 * 1000,
				status: 'open',
				source: 'llm',
				createdAt: now,
				updatedAt: now,
			})
		);

		const res = await t.mutation(internal.mail.dailyBrief.buildDailyBriefs, {});
		expect(res.built).toBe(1);

		const brief = await t.query(api.mail.dailyBrief.getLatestBrief, {
			mailboxId: seeded.mailboxId,
		});
		expect(brief).not.toBeNull();

		// Ranked "needs you" list: the commitment (high baseline) and the
		// high-priority reply are both present; the newsletter is NOT an item.
		const kinds = brief!.items.map((i) => i.kind);
		expect(kinds).toContain('needs_reply');
		expect(kinds).toContain('commitment');
		// Highest priority first.
		for (let i = 1; i < brief!.items.length; i++) {
			expect(brief!.items[i - 1]!.priorityScore).toBeGreaterThanOrEqual(
				brief!.items[i]!.priorityScore
			);
		}

		// Auditable bundle: the newsletter thread is listed and counted, and the
		// counts equal the listed entries (nothing hidden without a trail).
		expect(brief!.bundled.map((b) => b.threadId)).toContain(newsletterThread);
		expect(brief!.bundledCounts.newsletter).toBe(1);
		const total =
			brief!.bundledCounts.newsletter +
			brief!.bundledCounts.notification +
			brief!.bundledCounts.receipt;
		expect(total).toBe(brief!.bundled.length);
	});
});
