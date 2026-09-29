/**
 * applyResult (mail.needsReply) accepts every field the stored
 * `mailThreads.needsReply` shape carries, minus the ones it stamps itself.
 *
 * Regression: the argument validator was a hand copy of the schema and lost
 * `translations` on clarification questions. Convex validates internal
 * arguments exactly, so every localized clarification made applyResult throw,
 * the classifier swallowed it, and the whole LLM refinement (urgency, ask
 * summary, the "Needs your input" card) was dropped. The validator is now built
 * from the schema's own field record; this pins that a translated
 * clarification round-trips.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';

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

async function seedThread(
	t: ReturnType<typeof convexTest>
): Promise<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: 'user-A@owlat.test',
			domain: 'owlat.test',
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
		const threadId = await ctx.db.insert('mailThreads', {
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
			folderRoles: ['inbox'],
			labelIds: [],
			needsReplyPendingAt: now,
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
			threadId,
			fromAddress: 'ann@acme.com',
			fromName: 'Ann',
			toAddresses: ['user-A@owlat.test'],
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
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(threadId, { latestMessageId: messageId });
		return { threadId, messageId };
	});
}

describe('mail.needsReply.applyResult', () => {
	it('persists an LLM result whose clarification questions carry translations', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t);
		const askedAt = Date.now();

		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId,
			expectedLatestMessageId: messageId,
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'high',
				askSummary: 'Approve the refund',
				dueHint: '2026-10-01',
				meetingIntent: { isScheduling: false, proposedTimes: [] },
				clarification: {
					isNeeded: true,
					questions: [
						{
							id: 'clarify_0',
							slotType: 'decision',
							text: 'Should we approve the refund?',
							attribution:
								'Generated from an email from acme.com — Owlat will never ask for your password.',
							options: ['Yes', 'No'],
							translations: [
								{
									locale: 'de',
									text: 'Sollen wir die Rückerstattung genehmigen?',
									options: ['Ja', 'Nein'],
								},
							],
						},
					],
					askedAt,
				},
			},
		});

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			const flag = thread?.needsReply;
			expect(flag).toBeDefined();
			expect(flag?.source).toBe('llm');
			expect(flag?.urgency).toBe('high');
			expect(flag?.askSummary).toBe('Approve the refund');
			expect(flag?.dueHint).toBe('2026-10-01');
			expect(flag?.detectedAt).toBeGreaterThan(0);
			expect(flag?.clarification?.isNeeded).toBe(true);
			expect(flag?.clarification?.askedAt).toBe(askedAt);
			expect(flag?.clarification?.questions[0]?.translations).toEqual([
				{
					locale: 'de',
					text: 'Sollen wir die Rückerstattung genehmigen?',
					options: ['Ja', 'Nein'],
				},
			]);
			expect(thread?.needsReplyPendingAt).toBeUndefined();
		});
	});

	it('clears the flag on a null result', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seedThread(t);
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId,
			needsReply: { messageId, source: 'heuristic', urgency: 'normal' },
		});
		await t.mutation(internal.mail.needsReply.applyResult, { threadId, needsReply: null });

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			expect(thread?.needsReply).toBeUndefined();
			expect(thread?.needsReplyPendingAt).toBeUndefined();
		});
	});
});
