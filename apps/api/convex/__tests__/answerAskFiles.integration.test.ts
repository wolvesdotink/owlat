/**
 * Answer mode files and the send guard: the three file outcomes of plan §06 on
 * a Postbox draft, file answers (a fresh upload kept in Files unless the owner
 * opts out, a pick from Files), `mail.drafts.attachExisting` copying a Files row
 * or a mail attachment onto a draft and refusing what the caller may not read,
 * and `drafts.send` refusing a draft that still has gap placeholders
 * (DRAFT_HAS_GAPS). The model and the file search are mocked.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { runLlmStream } from '../lib/llm/dispatch';
import {
	ORG,
	seedCustomer,
	seedFile,
	seedMailAttachment,
	seedRequest,
	seedUpload,
} from './helpers/answerAsk';

import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import type * as LlmProviderModule from '../lib/llmProvider';
import type * as DispatchModule from '../lib/llm/dispatch';
import type * as AttachmentSuggestModule from '../inbox/attachmentSuggest';

type FoundFile = AttachmentSuggestModule.FoundFile;

const modules = import.meta.glob('../**/*.*s');

const sess = vi.hoisted(() => ({
	user: { userId: 'user-a', role: 'member' as 'member' | 'owner', activeOrganizationId: 'org-a' },
}));
const llm = vi.hoisted(() => ({ files: [] as FoundFile[] }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn(async () => sess.user),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => sess.user.userId),
		getMutationContext: vi.fn(async () => sess.user),
		getBetterAuthSessionWithRole: vi.fn(async () => ({ ...sess.user })),
	};
});
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof DispatchModule>('../lib/llm/dispatch');
	const result = { tokenUsage: undefined, modelUsed: 'test-model' };
	return {
		...actual,
		// No open slots: only the file request is in play.
		runLlmObject: vi.fn(async () => ({ object: { slots: [], translations: [] }, ...result })),
		runLlmText: vi.fn(async () => ({ text: 'A candidate reply.', ...result })),
		runLlmStream: vi.fn(async (opts: { onTextDelta?: (a: string, b: string) => unknown }) => {
			await opts.onTextDelta?.('Here it is.', 'Here it is.');
			return { text: 'Here it is.', ...result, finishReason: 'stop', aborted: false };
		}),
	};
});
vi.mock('../inbox/attachmentSuggest', async () => {
	const actual = await vi.importActual<typeof AttachmentSuggestModule>(
		'../inbox/attachmentSuggest'
	);
	return { ...actual, searchFilesForRequest: vi.fn(async () => llm.files) };
});

async function makeT() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external', 'ai']);
	return t;
}
type Tx = Awaited<ReturnType<typeof makeT>>;

async function replyDraft(t: Tx) {
	const { mailboxId, messageId } = await seedRequest(t);
	const { draftId } = await t.mutation(api.mail.drafts.create, {
		mailboxId,
		inReplyToMessageId: messageId,
	});
	return { mailboxId, draftId, target: { kind: 'mailDraft' as const, draftId } };
}

function hit(
	id: string,
	filename: string,
	score: number,
	source: FoundFile['source'] = 'semanticFile'
): FoundFile {
	return { source, id, filename, mimeType: 'application/pdf', size: 20, score };
}

async function draftRow(t: Tx, draftId: Id<'mailDrafts'>) {
	return (await t.run(async (ctx) => await ctx.db.get(draftId)))!;
}

async function blobText(t: Tx, storageId: Id<'_storage'>) {
	return await t.run(async (ctx) => await (await ctx.storage.get(storageId))!.text());
}

async function receipt(t: Tx, storageId: Id<'_storage'>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', storageId))
				.unique()
	);
}

beforeEach(() => {
	sess.user = { userId: 'user-a', role: 'member', activeOrganizationId: ORG };
	llm.files = [];
	vi.mocked(runLlmStream).mockClear();
});

describe('the three file outcomes on a draft', () => {
	it('one confident match is copied onto the draft without a question', async () => {
		const t = await makeT();
		const contactId = await seedCustomer(t);
		const fileId = await seedFile(t, {
			filename: 'invoice-2026-09-brightpath.pdf',
			contactIds: [contactId],
		});
		llm.files = [hit(fileId, 'invoice-2026-09-brightpath.pdf', 0.7)];
		const { target, draftId } = await replyDraft(t);

		const res = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		expect(res.status).toBe('ready');
		expect(res.questions).toEqual([]);
		expect(res.attachedFiles).toEqual([
			{ source: 'semanticFile', id: fileId, filename: 'invoice-2026-09-brightpath.pdf' },
		]);
		const [attachment] = (await draftRow(t, draftId)).attachments;
		expect(attachment?.filename).toBe('invoice-2026-09-brightpath.pdf');
		// A copy the draft owns, not the Files row's blob.
		const file = await t.run(async (ctx) => await ctx.db.get(fileId));
		expect(attachment!.storageId).not.toBe(file!.storageId);
		expect(await blobText(t, attachment!.storageId)).toBe('%PDF invoice-2026-09-brightpath.pdf');
		expect(await receipt(t, attachment!.storageId)).toMatchObject({
			status: 'bound',
			resourceKey: `mailDrafts:${draftId}`,
		});
		const prompt = JSON.stringify(vi.mocked(runLlmStream).mock.lastCall![0].messages);
		expect(prompt).toContain('mention them naturally: invoice-2026-09-brightpath.pdf');
	});

	it('several close matches ask which one; the pick is attached', async () => {
		const t = await makeT();
		const a = await seedFile(t, { filename: 'invoice-2026-09.pdf' });
		const b = await seedFile(t, { filename: 'invoice-2026-09-v2.pdf' });
		llm.files = [hit(a, 'invoice-2026-09.pdf', 0.6), hit(b, 'invoice-2026-09-v2.pdf', 0.6)];
		const { target, draftId } = await replyDraft(t);

		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		expect(asked.status).toBe('asking');
		const [question] = asked.questions;
		expect(question?.text).toContain('Which file should I attach');
		expect(question?.fileCandidates?.map((c) => c.id)).toEqual([a, b]);

		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [
				{ questionId: 'file_request', file: { source: 'semanticFile', id: b, filename: 'x' } },
			],
		});
		expect(res.status).toBe('ready');
		expect(res.attachedFiles).toEqual([
			{ source: 'semanticFile', id: b, filename: 'invoice-2026-09-v2.pdf' },
		]);
		expect((await draftRow(t, draftId)).attachments.map((x) => x.filename)).toEqual([
			'invoice-2026-09-v2.pdf',
		]);
	});

	it('a chip label names the candidate it was built from', async () => {
		const t = await makeT();
		const a = await seedFile(t, { filename: 'invoice-2026-09.pdf' });
		const b = await seedFile(t, { filename: 'invoice-2026-09-v2.pdf' });
		llm.files = [hit(a, 'invoice-2026-09.pdf', 0.6), hit(b, 'invoice-2026-09-v2.pdf', 0.6)];
		const { target, draftId } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId: asked.sessionId,
			answers: [{ questionId: 'file_request', value: 'invoice-2026-09.pdf' }],
		});

		expect(res.attachedFiles).toEqual([
			{ source: 'semanticFile', id: a, filename: 'invoice-2026-09.pdf' },
		]);
		expect((await draftRow(t, draftId)).attachments).toHaveLength(1);
	});

	it('nothing found asks for an upload, offering August as a noted near miss', async () => {
		const t = await makeT();
		const aug = await seedFile(t, { filename: 'invoice-2026-08-brightpath.pdf' });
		llm.files = [hit(aug, 'invoice-2026-08-brightpath.pdf', 0.6)];
		const { target } = await replyDraft(t);

		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });

		expect(asked.status).toBe('asking');
		expect(asked.questions[0]).toMatchObject({
			answerKind: 'file',
			options: ["It isn't ready yet"],
			fileCandidates: [expect.objectContaining({ id: aug, note: 'August' })],
		});
		expect(asked.attachedFiles).toEqual([]);
	});
});

describe('upload answers and Files', () => {
	async function askForUpload(t: Tx) {
		const contactId = await seedCustomer(t);
		const { target, draftId } = await replyDraft(t);
		const asked = await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		return { contactId, draftId, sessionId: asked.sessionId };
	}

	it('attaches the upload to the draft and keeps a contact-scoped copy in Files', async () => {
		const t = await makeT();
		const { contactId, draftId, sessionId } = await askForUpload(t);
		const upload = await seedUpload(t, { filename: 'invoice-2026-09.pdf' });

		const res = await t.action(api.mail.ai.composeDraft.answer, {
			sessionId,
			answers: [
				{
					questionId: 'file_request',
					file: { source: 'upload', id: upload, filename: 'invoice-2026-09.pdf' },
				},
			],
		});

		expect(res.status).toBe('ready');
		expect((await draftRow(t, draftId)).attachments[0]).toMatchObject({
			storageId: upload,
			filename: 'invoice-2026-09.pdf',
		});
		expect(await receipt(t, upload)).toMatchObject({
			status: 'bound',
			resourceKey: `mailDrafts:${draftId}`,
		});
		const kept = await t.run(async (ctx) => await ctx.db.query('semanticFiles').collect());
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			filename: 'invoice-2026-09.pdf',
			contactIds: [contactId],
			sourceType: 'upload',
			uploadedBy: 'user-a',
		});
		// Its own blob, freed with the Files row rather than with the reply.
		expect(kept[0]!.storageId).not.toBe(upload);
		expect(await receipt(t, kept[0]!.storageId!)).toMatchObject({
			resourceKey: `semanticFiles:${kept[0]!._id}`,
		});
	});

	it('keeps no copy when the owner opts out', async () => {
		const t = await makeT();
		const { draftId, sessionId } = await askForUpload(t);
		const upload = await seedUpload(t);

		await t.action(api.mail.ai.composeDraft.answer, {
			sessionId,
			answers: [
				{
					questionId: 'file_request',
					file: { source: 'upload', id: upload, filename: 'invoice.pdf' },
					keepCopy: false,
				},
			],
		});

		expect((await draftRow(t, draftId)).attachments).toHaveLength(1);
		expect(await t.run(async (ctx) => await ctx.db.query('semanticFiles').collect())).toEqual([]);
	});

	it('refuses somebody else’s upload', async () => {
		const t = await makeT();
		const { sessionId } = await askForUpload(t);
		const upload = await seedUpload(t, { userId: 'user-b' });
		await expect(
			t.action(api.mail.ai.composeDraft.answer, {
				sessionId,
				answers: [
					{ questionId: 'file_request', file: { source: 'upload', id: upload, filename: 'x.pdf' } },
				],
			})
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
	});
});

describe('mail.drafts.attachExisting', () => {
	it('copies a mail attachment from a mailbox the caller reads', async () => {
		const t = await makeT();
		const { mailboxId, draftId } = await replyDraft(t);
		const attachmentId = await seedMailAttachment(t, mailboxId, 'terms.pdf');

		const attachments = await t.action(api.mail.drafts.attachExisting, {
			draftId,
			source: 'mailAttachment',
			id: attachmentId,
		});

		expect(attachments.map((a) => a.filename)).toEqual(['terms.pdf']);
		expect(await blobText(t, attachments[0]!.storageId)).toBe('%PDF terms.pdf');
	});

	it('refuses another mailbox’s attachment', async () => {
		const t = await makeT();
		const { draftId } = await replyDraft(t);
		const other = await seedRequest(t, { userId: 'user-b', address: 'bea@example.com' });
		const attachmentId = await seedMailAttachment(t, other.mailboxId, 'payroll.pdf');
		await expect(
			t.action(api.mail.drafts.attachExisting, {
				draftId,
				source: 'mailAttachment',
				id: attachmentId,
			})
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
		expect((await draftRow(t, draftId)).attachments).toEqual([]);
	});

	it('refuses a file linked to another contact, allows the recipient’s and org-general ones', async () => {
		const t = await makeT();
		const customer = await seedCustomer(t);
		const stranger = await seedCustomer(t, 'someone@example.net');
		const { draftId } = await replyDraft(t);
		const theirs = await seedFile(t, { filename: 'contract-other.pdf', contactIds: [stranger] });
		const mine = await seedFile(t, { filename: 'invoice.pdf', contactIds: [customer] });
		const general = await seedFile(t, { filename: 'price-list.pdf' });

		await expect(
			t.action(api.mail.drafts.attachExisting, { draftId, source: 'semanticFile', id: theirs })
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
		await t.action(api.mail.drafts.attachExisting, { draftId, source: 'semanticFile', id: mine });
		const attachments = await t.action(api.mail.drafts.attachExisting, {
			draftId,
			source: 'semanticFile',
			id: general,
		});
		expect(attachments.map((a) => a.filename)).toEqual(['invoice.pdf', 'price-list.pdf']);
	});

	it('refuses a caller from another organization', async () => {
		const t = await makeT();
		const { draftId } = await replyDraft(t);
		const general = await seedFile(t, { filename: 'price-list.pdf' });
		sess.user = { userId: 'user-a', role: 'member', activeOrganizationId: 'org-b' };
		await expect(
			t.action(api.mail.drafts.attachExisting, { draftId, source: 'semanticFile', id: general })
		).rejects.toMatchObject({ data: { category: 'forbidden' } });
	});

	it('the mailbox attachment search only reads mailboxes the caller can', async () => {
		const t = await makeT();
		const { mailboxId } = await replyDraft(t);
		await seedMailAttachment(t, mailboxId, 'invoice-2026-09.pdf');
		const args = { mailboxId, queryText: 'invoice', limit: 5 };
		const own = await t.query(internal.mail.attachExisting.searchMailboxAttachments, args);
		expect(own.map((r) => r.filename)).toEqual(['invoice-2026-09.pdf']);
		sess.user = { userId: 'user-b', role: 'member', activeOrganizationId: ORG };
		expect(await t.query(internal.mail.attachExisting.searchMailboxAttachments, args)).toEqual([]);
	});
});

describe('sending a draft with gaps', () => {
	it('is refused while a placeholder remains, and allowed once it is filled', async () => {
		const t = await makeT();
		const { target, draftId } = await replyDraft(t);
		await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		const gap = 'Hi Jonas, [[attach invoice for september]]';
		await t.mutation(api.mail.drafts.update, { draftId, bodyHtml: `<p>${gap}</p>`, bodyText: gap });

		await expect(t.mutation(api.mail.drafts.send, { draftId })).rejects.toMatchObject({
			data: { category: 'invalid_state', data: { code: 'DRAFT_HAS_GAPS' } },
		});

		const filled = 'Hi Jonas, the invoice is attached.';
		await t.mutation(api.mail.drafts.update, {
			draftId,
			bodyHtml: `<p>${filled}</p>`,
			bodyText: filled,
		});
		const sent = await t.mutation(api.mail.drafts.send, { draftId });
		expect(sent.undoToken).toEqual(expect.any(String));
	});

	it('leaves hand-written double brackets alone on a draft without an ask session', async () => {
		const t = await makeT();
		const { draftId } = await replyDraft(t);
		const text = 'See [[wiki link]] for details.';
		await t.mutation(api.mail.drafts.update, {
			draftId,
			bodyHtml: `<p>${text}</p>`,
			bodyText: text,
		});
		const sent = await t.mutation(api.mail.drafts.send, { draftId });
		expect(sent.undoToken).toEqual(expect.any(String));
	});

	it('discarding a draft drops its ask sessions', async () => {
		const t = await makeT();
		const { target, draftId } = await replyDraft(t);
		await t.action(api.mail.ai.composeDraft.start, { target, locale: 'en' });
		await t.mutation(api.mail.drafts.discard, { draftId });
		expect(await t.run(async (ctx) => await ctx.db.query('answerAskSessions').collect())).toEqual(
			[]
		);
	});
});
