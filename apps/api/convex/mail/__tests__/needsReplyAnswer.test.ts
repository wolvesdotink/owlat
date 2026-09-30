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
	attribution: string;
	options?: string[];
	answerKind?: 'choice' | 'text' | 'date' | 'number' | 'file';
	answer?: { value: string; at: number; source?: 'user' | 'memory' };
};

const ATTRIBUTION =
	'Generated from an email from acme.com — Owlat will never ask for your password.';

async function seedThreadWithClarification(
	t: ReturnType<typeof convexTest>,
	userId: string,
	questions: SeedQuestion[] = [
		{
			id: 'clarify_0',
			slotType: 'decision',
			text: 'Should we approve the refund?',
			attribution: ATTRIBUTION,
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
		attribution: ATTRIBUTION,
		answer: { value: 'Yes, it is on it', at: 1, source: 'memory' },
	};
	const fileQuestion: SeedQuestion = {
		id: 'clarify_1',
		slotType: 'attachment',
		answerKind: 'file',
		text: 'Which invoice should I attach?',
		attribution: ATTRIBUTION,
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
			attribution: ATTRIBUTION,
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

		// The starter draft is told the file is attached, and recalls knowledge
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
		expect(draftContext?.fileNotes).toContain('"invoice-2026-08.pdf" is attached');
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
});
