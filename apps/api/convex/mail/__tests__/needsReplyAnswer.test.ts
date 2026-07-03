/**
 * answerClarification (mail.needsReply) — the owner answers a "Needs your
 * input" Reply Queue card.
 *
 * Asserts the mutation persists each answer onto
 * `needsReply.clarification.questions[].answer`, stamps `answeredAt`, marks the
 * clarification no longer `needed`, and schedules `draftWithAnswers` (the path
 * that produces the starter reply). Ownership is enforced by loadOwnedMailbox.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

async function seedThreadWithClarification(
	t: ReturnType<typeof convexTest>,
	userId: string,
): Promise<Id<'mailThreads'>> {
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'org-1',
			address: `${userId}@hinterland.camp`,
			domain: 'hinterland.camp',
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
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m1@acme.com>',
			threadId: 'placeholder' as Id<'mailThreads'>,
			fromAddress: 'ann@acme.com',
			fromName: 'Ann',
			toAddresses: [`${userId}@hinterland.camp`],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Refund?',
			normalizedSubject: 'refund?',
			snippet: 'Can you approve the refund?',
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
		});
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'refund?',
			participants: ['ann@acme.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Can you approve the refund?',
			latestFromAddress: 'ann@acme.com',
			latestSubject: 'Refund?',
			latestMessageId: messageId,
			folderRoles: ['inbox'],
			labelIds: [],
			needsReply: {
				messageId,
				detectedAt: now,
				source: 'llm',
				urgency: 'normal',
				clarification: {
					needed: true,
					questions: [
						{
							id: 'clarify_0',
							slotType: 'decision',
							text: 'Should we approve the refund?',
							attribution: 'Generated from an email from acme.com — Owlat will never ask for your password.',
							options: ['Yes', 'No'],
						},
					],
					askedAt: now,
				},
			},
		});
		await ctx.db.patch(messageId, { threadId });
	});
	return threadId;
}

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
});

describe('mail.needsReply.answerClarification', () => {
	it('persists the answer, stamps answeredAt, and schedules draftWithAnswers', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThreadWithClarification(t, 'user-A');

		const res = await t.mutation(api.mail.needsReply.answerClarification, {
			threadId,
			answers: [{ questionId: 'clarify_0', value: 'Yes' }],
		});
		expect(res).toEqual({ success: true });

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			const clarification = thread?.needsReply?.clarification;
			expect(clarification?.answeredAt).toBeGreaterThan(0);
			expect(clarification?.needed).toBe(false);
			expect(clarification?.questions[0]?.answer?.value).toBe('Yes');

			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.some((s) => s.name.includes('draftWithAnswers'))).toBe(true);
		});
	});

	it("rejects a non-owner's answer", async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThreadWithClarification(t, 'user-A');
		sessionMocks.userId = 'user-B';
		await expect(
			t.mutation(api.mail.needsReply.answerClarification, {
				threadId,
				answers: [{ questionId: 'clarify_0', value: 'Yes' }],
			}),
		).rejects.toThrow();
	});
});
