/**
 * answerClarification (mail.needsReplyClarify) — the owner answers a "Needs your
 * input" Reply Queue card.
 *
 * Asserts the mutation persists each answer onto
 * `needsReply.clarification.questions[].answer`, stamps `answeredAt`, marks the
 * clarification no longer `needed`, and schedules `draftWithAnswers` (the path
 * that produces the starter reply). Ownership is enforced by requireMailboxAccess.
 *
 * Answer mode additions: a card whose questions memory pre-picked can be
 * confirmed as it stands, kept memory answers are not re-captured, and a file
 * answer (mail attachment or upload) is checked before it is stored.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import {
	createTestContact,
	createTestContactIdentity,
	enableFeatures,
} from '../../__tests__/factories';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';
import { findDraftGaps } from '@owlat/shared/answerMode';
import { fitGapPlaceholders } from '../ai/composeDraftPolicy';
import { MAX_CLARIFICATION_DRAFT_CHARS } from '../../inbox/clarificationAnswers';

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
			activeOrganizationId: 'org-1',
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

type SeedQuestion = {
	id: string;
	slotType: string;
	text: string;
	origin: { kind: 'email'; senderDomain?: string };
	options?: string[];
	answerKind?: 'choice' | 'text' | 'date' | 'number' | 'file';
	answer?: { value: string; at: number; source?: 'user' | 'memory' };
};

const ORIGIN = { kind: 'email', senderDomain: 'acme.com' } as const;

async function seedThreadWithClarification(
	t: ReturnType<typeof convexTest>,
	userId: string,
	questions: SeedQuestion[] = [
		{
			id: 'clarify_0',
			slotType: 'decision',
			text: 'Should we approve the refund?',
			origin: ORIGIN,
			options: ['Yes', 'No'],
		},
	]
): Promise<Id<'mailThreads'>> {
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'org-1',
			address: `${userId}@owlat.test`,
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
		// Insert the thread first (latestMessageId is optional) so the message can
		// reference a REAL thread Id — a placeholder Id fails convex-test's
		// validator and errors the whole test at setup.
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
			folderRoles: ['inbox'],
			labelIds: [],
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
			toAddresses: [`${userId}@owlat.test`],
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
		await ctx.db.patch(threadId, {
			latestMessageId: messageId,
			needsReply: {
				messageId,
				detectedAt: now,
				source: 'llm',
				urgency: 'normal',
				clarification: {
					isNeeded: true,
					questions,
					askedAt: now,
				},
			},
		});
	});
	return threadId;
}

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
});

describe('mail.needsReplyClarify.answerClarification', () => {
	it('persists the answer, stamps answeredAt, and schedules draftWithAnswers', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A');

		const res = await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
			threadId,
			answers: [{ questionId: 'clarify_0', value: 'Yes' }],
		});
		expect(res).toEqual({ success: true });

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			const clarification = thread?.needsReply?.clarification;
			expect(clarification?.answeredAt).toBeGreaterThan(0);
			expect(clarification?.isNeeded).toBe(false);
			expect(clarification?.questions[0]?.answer?.value).toBe('Yes');

			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.some((s) => s.name.includes('draftWithAnswers'))).toBe(true);
		});
	});

	it('rejects a payload whose questionIds match no open question', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A');

		await expect(
			t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
				threadId,
				answers: [{ questionId: 'does_not_exist', value: 'Yes' }],
			})
		).rejects.toThrow();

		// The clarification must NOT be stamped answered — no strand into 'drafting'.
		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			const clarification = thread?.needsReply?.clarification;
			expect(clarification?.answeredAt).toBeUndefined();
			expect(clarification?.isNeeded).toBe(true);
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.some((s) => s.name.includes('draftWithAnswers'))).toBe(false);
		});
	});

	it("rejects a non-owner's answer", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A');
		sessionMocks.userId = 'user-B';
		await expect(
			t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
				threadId,
				answers: [{ questionId: 'clarify_0', value: 'Yes' }],
			})
		).rejects.toThrow();
	});
});

/** The mailbox + message the seeded thread lives in. */
async function threadRefs(t: ReturnType<typeof convexTest>, threadId: Id<'mailThreads'>) {
	return await t.run(async (ctx) => {
		const thread = (await ctx.db.get(threadId))!;
		return { mailboxId: thread.mailboxId, messageId: thread.latestMessageId! };
	});
}

async function insertAttachment(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	messageId: Id<'mailMessages'>
): Promise<Id<'mailAttachments'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('mailAttachments', {
			mailboxId,
			messageId,
			filename: 'invoice-2026-08.pdf',
			contentType: 'application/pdf',
			size: 84_000,
			receivedAt: Date.now(),
			fromAddress: 'ann@acme.com',
			partIndex: '2',
		})
	);
}

describe('mail.needsReplyClarify.answerClarification — Answer mode', () => {
	const memoryQuestion: SeedQuestion = {
		id: 'clarify_0',
		slotType: 'factual_lookup',
		answerKind: 'text',
		text: 'Is the PO number printed on the invoice?',
		origin: ORIGIN,
		answer: { value: 'Yes, it is on it', at: 1, source: 'memory' },
	};
	const fileQuestion: SeedQuestion = {
		id: 'clarify_1',
		slotType: 'attachment',
		answerKind: 'file',
		text: 'Which invoice should I attach?',
		origin: ORIGIN,
	};

	it('confirms a card whose every question memory pre-picked, as it stands', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A', [memoryQuestion]);

		await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, { threadId, answers: [] });

		await t.run(async (ctx) => {
			const clarification = (await ctx.db.get(threadId))?.needsReply?.clarification;
			expect(clarification?.answeredAt).toBeGreaterThan(0);
			expect(clarification?.questions[0]?.answer).toMatchObject({
				value: 'Yes, it is on it',
				source: 'memory',
			});
		});
	});

	it('remembers typed answers but not kept memory answers or file answers', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const typed: SeedQuestion = {
			id: 'clarify_2',
			slotType: 'decision',
			text: 'Should we invoice monthly?',
			origin: ORIGIN,
		};
		const threadId = await seedThreadWithClarification(t, 'user-A', [
			memoryQuestion,
			fileQuestion,
			typed,
		]);
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', createTestContact({ email: 'ann@acme.com' }));
			await ctx.db.insert(
				'contactIdentities',
				createTestContactIdentity({ contactId: id, identifier: 'ann@acme.com' })
			);
			return id;
		});

		await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
			threadId,
			answers: [
				{ questionId: 'clarify_0', value: 'Yes, it is on it', source: 'memory' },
				{ questionId: 'clarify_1', value: "It isn't ready yet" },
				{ questionId: 'clarify_2', value: 'Yes, monthly' },
			],
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('clarificationMemory').collect();
			expect(rows.map((r) => [r.contactId, r.answerValue])).toEqual([[contactId, 'Yes, monthly']]);
			const questions = (await ctx.db.get(threadId))!.needsReply!.clarification!.questions;
			expect(questions.map((q) => q.answer?.source)).toEqual(['memory', 'user', 'user']);
		});
	});

	it('stores a mail attachment the owner can read as the file answer', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A', [fileQuestion]);
		const { mailboxId, messageId } = await threadRefs(t, threadId);
		const attachmentId = await insertAttachment(t, mailboxId, messageId);

		await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
			threadId,
			answers: [
				{
					questionId: 'clarify_1',
					file: { source: 'mailAttachment', id: attachmentId, filename: 'renamed.pdf' },
				},
			],
		});

		await t.run(async (ctx) => {
			const answer = (await ctx.db.get(threadId))!.needsReply!.clarification!.questions[0]!.answer;
			expect(answer).toMatchObject({
				value: 'invoice-2026-08.pdf',
				source: 'user',
				file: { source: 'mailAttachment', id: attachmentId, filename: 'invoice-2026-08.pdf' },
			});
		});

		// The starter draft is told the file will be attached, and recalls knowledge
		// for the sender's contact when one resolves.
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('contacts', createTestContact({ email: 'ann@acme.com' }));
			await ctx.db.insert(
				'contactIdentities',
				createTestContactIdentity({ contactId: id, identifier: 'ann@acme.com' })
			);
			return id;
		});
		const draftContext = await t.query(internal.mail.ai.needsReplyClarify.getClarificationContext, {
			threadId,
		});
		expect(draftContext).toMatchObject({
			contactId,
			ownerAddress: 'user-A@owlat.test',
			answers: [{ question: 'Which invoice should I attach?', answer: 'invoice-2026-08.pdf' }],
		});
		expect(draftContext?.fileNotes).toContain('"invoice-2026-08.pdf" will be attached');
	});

	// "Send us the invoices for our four bookings": one question, several files.
	it('stores several files on one answer and tells the draft about each', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A', [fileQuestion]);
		const { mailboxId, messageId } = await threadRefs(t, threadId);
		const first = await insertAttachment(t, mailboxId, messageId);
		const second = await t.run(async (ctx) =>
			ctx.db.insert('mailAttachments', {
				mailboxId,
				messageId,
				filename: 'invoice-2026-09.pdf',
				contentType: 'application/pdf',
				size: 91_000,
				receivedAt: Date.now(),
				fromAddress: 'ann@acme.com',
				partIndex: '3',
			})
		);

		await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
			threadId,
			answers: [
				{
					questionId: 'clarify_1',
					files: [
						{ source: 'mailAttachment', id: first, filename: 'a.pdf' },
						{ source: 'mailAttachment', id: second, filename: 'b.pdf' },
					],
				},
			],
		});

		await t.run(async (ctx) => {
			const answer = (await ctx.db.get(threadId))!.needsReply!.clarification!.questions[0]!.answer;
			expect(answer).toMatchObject({
				value: 'invoice-2026-08.pdf, invoice-2026-09.pdf',
				file: { source: 'mailAttachment', id: first, filename: 'invoice-2026-08.pdf' },
				files: [
					{ source: 'mailAttachment', id: first, filename: 'invoice-2026-08.pdf' },
					{ source: 'mailAttachment', id: second, filename: 'invoice-2026-09.pdf' },
				],
			});
		});
		const draftContext = await t.query(internal.mail.ai.needsReplyClarify.getClarificationContext, {
			threadId,
		});
		expect(draftContext?.fileNotes).toContain('"invoice-2026-08.pdf" will be attached');
		expect(draftContext?.fileNotes).toContain('"invoice-2026-09.pdf" will be attached');
		expect(draftContext?.fileGaps).toEqual([]);
	});

	it('leaves a placeholder for a file question answered around', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A', [
			fileQuestion,
			{ id: 'clarify_2', slotType: 'decision', text: 'Invoice monthly?', origin: ORIGIN },
		]);

		await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
			threadId,
			answers: [{ questionId: 'clarify_2', value: 'Yes' }],
		});

		const draftContext = await t.query(internal.mail.ai.needsReplyClarify.getClarificationContext, {
			threadId,
		});
		expect(draftContext?.fileGaps).toEqual(['[[Which invoice should I attach]]']);
	});

	it('stores a long starter reply with its file placeholder whole', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A', [fileQuestion]);
		const gap = '[[Provide the invoices]]';

		await t.mutation(internal.mail.ai.needsReplyClarify.persistClarificationDraft, {
			threadId,
			draft: fitGapPlaceholders('A'.repeat(4000), [gap], MAX_CLARIFICATION_DRAFT_CHARS),
		});

		const stored = await t.run(
			async (ctx) => (await ctx.db.get(threadId))!.needsReply!.clarification!.draft!
		);
		expect(stored.length).toBeLessThanOrEqual(MAX_CLARIFICATION_DRAFT_CHARS);
		expect(findDraftGaps(stored).map((g) => g.label)).toEqual(['Provide the invoices']);
	});

	it("refuses another person's mail attachment and a file on a non-file question", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const theirs = await seedThreadWithClarification(t, 'user-B');
		const { mailboxId, messageId } = await threadRefs(t, theirs);
		const foreign = await insertAttachment(t, mailboxId, messageId);
		const threadId = await seedThreadWithClarification(t, 'user-A', [
			fileQuestion,
			{ ...memoryQuestion, answer: undefined },
		]);

		await expect(
			t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
				threadId,
				answers: [
					{
						questionId: 'clarify_1',
						file: { source: 'mailAttachment', id: foreign, filename: 'x.pdf' },
					},
				],
			})
		).rejects.toThrow(/not accessible/i);
		await expect(
			t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
				threadId,
				answers: [
					{
						questionId: 'clarify_0',
						file: { source: 'mailAttachment', id: foreign, filename: 'x.pdf' },
					},
				],
			})
		).rejects.toThrow(/does not take a file/);
	});

	it("keeps a member's upload out of Files (adding to Files is an admin action)", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const threadId = await seedThreadWithClarification(t, 'user-A', [fileQuestion]);
		const storageId = await t.run(async (ctx) => {
			const id = await ctx.storage.store(new Blob(['%PDF']));
			await ctx.db.insert('storageUploads', {
				userId: 'user-A',
				organizationId: 'org-1',
				status: 'uploaded',
				storageId: id,
				expiresAt: Date.now() + 60_000,
			});
			return id;
		});

		await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
			threadId,
			answers: [
				{ questionId: 'clarify_1', file: { source: 'upload', id: storageId, filename: 'inv.pdf' } },
			],
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.query('semanticFiles').collect()).toEqual([]);
			const answer = (await ctx.db.get(threadId))!.needsReply!.clarification!.questions[0]!.answer;
			expect(answer?.file).toEqual({ source: 'upload', id: storageId, filename: 'inv.pdf' });
		});
	});

	describe('the answered file reaches the prepared reply', () => {
		async function stagedUpload(t: ReturnType<typeof convexTest>) {
			return await t.run(async (ctx) => {
				const id = await ctx.storage.store(new Blob(['%PDF'], { type: 'application/pdf' }));
				await ctx.db.insert('storageUploads', {
					userId: 'user-A',
					organizationId: 'org-1',
					status: 'uploaded',
					storageId: id,
					expiresAt: Date.now() + 60_000,
				});
				return id;
			});
		}
		async function replyDraftFor(t: ReturnType<typeof convexTest>, threadId: Id<'mailThreads'>) {
			const thread = await t.run(async (ctx) => (await ctx.db.get(threadId))!);
			const { draftId } = await t.mutation(api.mail.drafts.create, {
				mailboxId: thread.mailboxId,
				inReplyToMessageId: thread.latestMessageId!,
			});
			return draftId;
		}

		it("a member's upload is held by the thread until the draft takes it over", async () => {
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['mail.external']);
			const threadId = await seedThreadWithClarification(t, 'user-A', [fileQuestion]);
			const storageId = await stagedUpload(t);
			await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
				threadId,
				answers: [
					{
						questionId: 'clarify_1',
						file: { source: 'upload', id: storageId, filename: 'inv.pdf' },
					},
				],
			});

			// Held by the thread, so it outlives its upload receipt's hour.
			const held = await t.run(async (ctx) =>
				ctx.db
					.query('storageUploads')
					.withIndex('by_storage', (q) => q.eq('storageId', storageId))
					.unique()
			);
			expect(held).toMatchObject({ status: 'bound', resourceKey: `mailThreads:${threadId}` });
			const draftContext = await t.query(
				internal.mail.ai.needsReplyClarify.getClarificationContext,
				{
					threadId,
				}
			);
			expect(draftContext?.fileNotes).toContain('"inv.pdf" will be attached');
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
			let prepared;
			try {
				prepared = await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId });
			} finally {
				vi.useRealTimers();
			}
			expect(prepared?.files).toEqual([{ source: 'upload', id: storageId, filename: 'inv.pdf' }]);

			const draftId = await replyDraftFor(t, threadId);
			const file = prepared!.files[0]!;
			await t.mutation(api.mail.drafts.addAttachment, {
				draftId,
				storageId: file.id as Id<'_storage'>,
				filename: file.filename,
				contentType: 'application/pdf',
				size: 4,
			});
			const draft = await t.run(async (ctx) => (await ctx.db.get(draftId))!);
			expect(draft.attachments.map((a) => a.storageId)).toEqual([storageId]);
			const moved = await t.run(async (ctx) =>
				ctx.db
					.query('storageUploads')
					.withIndex('by_storage', (q) => q.eq('storageId', storageId))
					.unique()
			);
			expect(moved?.resourceKey).toBe(`mailDrafts:${draftId}`);
			// Bound now, so the prepared reply stops offering it.
			const after = await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId });
			expect(after?.files).toEqual([]);
		});

		it("an admin's upload is kept in Files and comes back as the Files row", async () => {
			// The new Files row's processing pass runs in a module this suite leaves out.
			expectScheduledFailure('semanticFileProcessing:processFile');
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['mail.external']);
			sessionMocks.role = 'owner';
			const threadId = await seedThreadWithClarification(t, 'user-A', [fileQuestion]);
			await t.run(async (ctx) => {
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'ann@acme.com' })
				);
				await ctx.db.insert(
					'contactIdentities',
					createTestContactIdentity({ contactId, identifier: 'ann@acme.com' })
				);
			});
			const storageId = await stagedUpload(t);
			await t.mutation(api.mail.ai.needsReplyClarify.answerClarification, {
				threadId,
				answers: [
					{
						questionId: 'clarify_1',
						file: { source: 'upload', id: storageId, filename: 'inv.pdf' },
						mimeType: 'application/pdf',
					},
				],
			});

			const prepared = await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId });
			const saved = await t.run(async (ctx) => await ctx.db.query('semanticFiles').unique());
			expect(prepared?.files).toEqual([
				{ source: 'semanticFile', id: saved!._id, filename: 'inv.pdf' },
			]);

			const draftId = await replyDraftFor(t, threadId);
			const attachments = await t.action(api.mail.drafts.attachExisting, {
				draftId,
				source: 'semanticFile',
				id: prepared!.files[0]!.id,
			});
			expect(attachments.map((a) => a.filename)).toEqual(['inv.pdf']);
		});
	});
});
