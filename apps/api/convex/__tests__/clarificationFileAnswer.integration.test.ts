/**
 * `inbox.answerClarification` with file answers (Answer mode, plan §06).
 *
 * Covers:
 *   - a Files pick is stored on the answer and recorded as the message's
 *     confident attachment suggestion (the resumed draft keeps it);
 *   - an older client's chip label resolves to the candidate it was built from;
 *   - an upload is saved to Files for the sender's contact (receipt bound), or
 *     kept out of Files with `keepCopy: false`;
 *   - someone else's upload, a mail attachment, and a file on a non-file
 *     question are refused;
 *   - "It isn't ready yet" stays a plain answer, and file answers never become
 *     standing answer memory while typed answers still do.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createTestContact, createTestInboundMessage, createTestSemanticFile } from './factories';
import { expectScheduledFailure } from './helpers/scheduledFailures';

// The resume and the new file's processing pass run in modules this suite's
// map leaves out; their jobs fail when they fire. Not what these tests are about.
beforeEach(() => {
	expectScheduledFailure('agent/walker:resumeDraft');
	expectScheduledFailure('semanticFileProcessing:processFile');
});

const OWNER = 'test-user-123';
const ORG = 'org-1';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = async (ctx: MutationCtx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Not authenticated');
		return { userId: identity.subject, role: 'owner', activeOrganizationId: 'org-1' };
	};
	return { ...actual, getMutationContext: vi.fn(session), requireAdminContext: vi.fn(session) };
});
vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const identity = {
	subject: OWNER,
	issuer: 'https://test.issuer.com',
	tokenIdentifier: `https://test.issuer.com|${OWNER}`,
};

interface Seeded {
	messageId: Id<'inboundMessages'>;
	contactId: Id<'contacts'>;
	fileA: Id<'semanticFiles'>;
	fileB: Id<'semanticFiles'>;
}

/** A message parked on a "which file?" question plus a typed question. */
async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const storeA = await ctx.storage.store(new Blob(['%PDF a'], { type: 'application/pdf' }));
		const storeB = await ctx.storage.store(new Blob(['%PDF b'], { type: 'application/pdf' }));
		const fileA = await ctx.db.insert(
			'semanticFiles',
			createTestSemanticFile({
				storageId: storeA,
				filename: 'contract-v2.pdf',
				title: 'Signed contract',
				contactIds: [contactId],
			})
		);
		const fileB = await ctx.db.insert(
			'semanticFiles',
			createTestSemanticFile({
				storageId: storeB,
				filename: 'contract-v1.pdf',
				contactIds: [contactId],
			})
		);
		const messageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				threadId: undefined,
				contactId,
				processingStatus: 'awaiting_clarification',
				classification: {
					category: 'support',
					priority: 'normal',
					sentiment: 'neutral',
					intent: 'question',
					confidence: 0.8,
				},
				pendingClarification: {
					questions: [
						{
							id: 'clarify_attachment',
							slotType: 'attachment',
							answerKind: 'file',
							text: 'Which file should I attach to this reply?',
							options: ['Signed contract', 'contract-v1.pdf'],
							fileCandidates: [
								{
									source: 'semanticFile',
									id: fileA,
									filename: 'contract-v2.pdf',
									title: 'Signed contract',
									mimeType: 'application/pdf',
									size: 6,
									score: 0.6,
								},
								{
									source: 'semanticFile',
									id: fileB,
									filename: 'contract-v1.pdf',
									mimeType: 'application/pdf',
									size: 6,
									score: 0.58,
								},
							],
						},
						{
							id: 'clarify_0',
							slotType: 'decision',
							answerKind: 'text',
							text: 'Should we extend the deadline?',
						},
					],
					askedAt: 1000,
				},
			})
		);
		return { messageId, contactId, fileA, fileB };
	});
}

/** A fresh upload receipt, as the upload proxy leaves it before a mutation claims it. */
async function stageUpload(t: ReturnType<typeof convexTest>, userId = OWNER) {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob(['%PDF upload'], { type: 'application/pdf' })
		);
		await ctx.db.insert('storageUploads', {
			userId,
			organizationId: ORG,
			status: 'uploaded',
			storageId,
			expiresAt: Date.now() + 60_000,
		});
		return storageId;
	});
}

function answer(
	t: ReturnType<typeof convexTest>,
	messageId: Id<'inboundMessages'>,
	answers: unknown[]
) {
	return t.withIdentity(identity).mutation(api.inbox.clarification.answerClarification, {
		inboundMessageId: messageId,
		answers: answers as never,
	});
}

async function readMessage(t: ReturnType<typeof convexTest>, id: Id<'inboundMessages'>) {
	return await t.run(async (ctx) => (await ctx.db.get(id))!);
}

describe('inbox.answerClarification — file answers', () => {
	it('stores a Files pick and records it as the confident attachment suggestion', async () => {
		const t = convexTest(schema, modules);
		const { messageId, fileA } = await seed(t);

		await answer(t, messageId, [
			{
				questionId: 'clarify_attachment',
				file: { source: 'semanticFile', id: fileA, filename: 'ignored.pdf' },
			},
		]);

		const msg = await readMessage(t, messageId);
		expect(msg.processingStatus).toBe('drafting');
		const q = msg.pendingClarification!.questions[0]!;
		// The stored filename is the row's, not the client's.
		expect(q.answer).toMatchObject({
			value: 'contract-v2.pdf',
			source: 'user',
			file: { source: 'semanticFile', id: fileA, filename: 'contract-v2.pdf' },
		});
		expect(msg.attachmentSuggestions).toMatchObject({
			ambiguous: false,
			candidates: [
				{ fileId: fileA, filename: 'contract-v2.pdf', title: 'Signed contract', score: 1 },
			],
		});
	});

	it("resolves an older client's chip label to the candidate file", async () => {
		const t = convexTest(schema, modules);
		const { messageId, fileB } = await seed(t);

		await answer(t, messageId, [{ questionId: 'clarify_attachment', value: 'contract-v1.pdf' }]);

		const msg = await readMessage(t, messageId);
		const q = msg.pendingClarification!.questions[0]!;
		expect(q.answer?.file).toEqual({
			source: 'semanticFile',
			id: fileB,
			filename: 'contract-v1.pdf',
		});
		expect(msg.attachmentSuggestions?.candidates[0]?.fileId).toBe(fileB);
	});

	it('saves an uploaded answer to Files for the sender and binds the upload', async () => {
		const t = convexTest(schema, modules);
		const { messageId, contactId } = await seed(t);
		const storageId = await stageUpload(t);

		await answer(t, messageId, [
			{
				questionId: 'clarify_attachment',
				file: { source: 'upload', id: storageId, filename: 'contract-final.pdf' },
				mimeType: 'application/pdf',
			},
		]);

		await t.run(async (ctx) => {
			const saved = await ctx.db
				.query('semanticFiles')
				.filter((q) => q.eq(q.field('storageId'), storageId))
				.unique();
			expect(saved).toMatchObject({
				filename: 'contract-final.pdf',
				mimeType: 'application/pdf',
				sourceType: 'upload',
				uploadedBy: OWNER,
				contactIds: [contactId],
			});
			const receipt = await ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', storageId))
				.unique();
			expect(receipt).toMatchObject({
				status: 'bound',
				resourceKey: `semanticFiles:${saved!._id}`,
			});

			const msg = (await ctx.db.get(messageId))!;
			expect(msg.pendingClarification!.questions[0]!.answer?.file).toEqual({
				source: 'semanticFile',
				id: saved!._id,
				filename: 'contract-final.pdf',
			});
			expect(msg.attachmentSuggestions?.candidates[0]?.fileId).toBe(saved!._id);
		});
	});

	it('keeps an upload out of Files when keepCopy is false', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t);
		const storageId = await stageUpload(t);

		await answer(t, messageId, [
			{
				questionId: 'clarify_attachment',
				file: { source: 'upload', id: storageId, filename: 'contract-final.pdf' },
				keepCopy: false,
			},
		]);

		await t.run(async (ctx) => {
			const files = await ctx.db
				.query('semanticFiles')
				.filter((q) => q.eq(q.field('storageId'), storageId))
				.collect();
			expect(files).toEqual([]);
			const receipt = await ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', storageId))
				.unique();
			expect(receipt?.status).toBe('uploaded');
			const msg = (await ctx.db.get(messageId))!;
			expect(msg.pendingClarification!.questions[0]!.answer?.file).toEqual({
				source: 'upload',
				id: storageId,
				filename: 'contract-final.pdf',
			});
			expect(msg.attachmentSuggestions).toBeUndefined();
		});
	});

	it("refuses someone else's upload", async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t);
		const storageId = await stageUpload(t, 'someone-else');

		await expect(
			answer(t, messageId, [
				{
					questionId: 'clarify_attachment',
					file: { source: 'upload', id: storageId, filename: 'x.pdf' },
				},
			])
		).rejects.toThrow(/unclaimed upload/i);
		expect((await readMessage(t, messageId)).processingStatus).toBe('awaiting_clarification');
	});

	it('refuses a mail attachment and a file on a question that does not take one', async () => {
		const t = convexTest(schema, modules);
		const { messageId, fileA } = await seed(t);

		await expect(
			answer(t, messageId, [
				{
					questionId: 'clarify_attachment',
					file: { source: 'mailAttachment', id: 'anything', filename: 'x.pdf' },
				},
			])
		).rejects.toThrow(/Pick a file from Files/);
		await expect(
			answer(t, messageId, [
				{
					questionId: 'clarify_0',
					file: { source: 'semanticFile', id: fileA, filename: 'x.pdf' },
				},
			])
		).rejects.toThrow(/does not take a file/);
	});

	it('keeps "It isn\'t ready yet" as a plain answer and never remembers file answers', async () => {
		const t = convexTest(schema, modules);
		const { messageId, contactId } = await seed(t);

		await answer(t, messageId, [
			{ questionId: 'clarify_attachment', value: "It isn't ready yet" },
			{ questionId: 'clarify_0', value: 'Yes, two weeks' },
		]);

		const msg = await readMessage(t, messageId);
		expect(msg.pendingClarification!.questions[0]!.answer).toMatchObject({
			value: "It isn't ready yet",
		});
		expect(msg.pendingClarification!.questions[0]!.answer?.file).toBeUndefined();
		expect(msg.attachmentSuggestions).toBeUndefined();

		await t.run(async (ctx) => {
			const remembered = await ctx.db.query('clarificationMemory').collect();
			expect(remembered.map((r) => [r.contactId, r.slotType, r.answerValue])).toEqual([
				[contactId, 'decision', 'Yes, two weeks'],
			]);
		});
	});
});
