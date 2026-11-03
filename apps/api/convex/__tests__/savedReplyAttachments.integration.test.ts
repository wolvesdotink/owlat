/**
 * Files on saved replies (mail/savedReplyAttachments.ts):
 *
 *  - a create or update binds the caller's uploads to the reply, refuses
 *    someone else's, and an edit that drops a file deletes it, as does
 *    removing the reply;
 *  - inserting a reply puts its files on the draft by reference: no blob is
 *    copied, inserting it twice attaches once, and no draft path (removing
 *    the file, discarding the draft) deletes the reply's bytes;
 *  - a draft whose borrowed file is gone refuses to send, and a borrowed file
 *    cannot be turned into a share link;
 *  - deleting the workspace deletes the reply's file once, through the reply.
 */
import { convexTest as baseConvexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { recordUploadedBlob } from './uploadFixtures.testlib';
import { seedMailbox } from '../mail/__tests__/helpers.testlib';
import { mailDraftsStep } from '../workspaces/deletion/steps/mailDrafts';
import { mailSnippetsStep } from '../workspaces/deletion/steps/mailSnippets';
import { storageUploadsStep } from '../workspaces/deletion/steps/storageUploads';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

function convexTest(): Harness {
	const t = baseConvexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	session.userId = 'user-A';
	session.role = 'owner';
});

async function uploaded(t: Harness, content = 'price list', owner = 'user-A') {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([content]));
		await recordUploadedBlob(ctx, storageId, owner);
		return storageId;
	});
}

const file = (storageId: Id<'_storage'>, filename = 'prices.pdf') => ({
	storageId,
	filename,
	contentType: 'application/pdf',
});

const blobExists = (t: Harness, storageId: Id<'_storage'>) =>
	t.run(async (ctx) => (await ctx.db.system.get(storageId)) !== null);
const blobCount = (t: Harness) =>
	t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length);
const receiptOf = (t: Harness, storageId: Id<'_storage'>) =>
	t.run((ctx) =>
		ctx.db
			.query('storageUploads')
			.withIndex('by_storage', (q) => q.eq('storageId', storageId))
			.unique()
	);

async function replyWithFile(t: Harness, scope: 'personal' | 'shared' = 'personal') {
	const storageId = await uploaded(t);
	const replyId = await t.mutation(api.mail.savedReplies.create, {
		scope,
		name: 'Prices',
		shortcut: 'prices',
		bodyHtml: '<p>Our prices are attached.</p>',
		attachments: [file(storageId)],
	});
	return { replyId, storageId };
}

async function draft(t: Harness) {
	const mailboxId = await seedMailbox(t);
	const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
	return { mailboxId, draftId };
}

describe('saved reply files', () => {
	it('binds the caller’s upload to the reply and measures it on the server', async () => {
		const t = convexTest();
		await seedMailbox(t);
		const { replyId, storageId } = await replyWithFile(t);

		const [mine] = await t.query(api.mail.savedReplies.listMine, {});
		expect(mine?.attachments).toEqual([
			{ storageId, filename: 'prices.pdf', contentType: 'application/pdf', size: 10 },
		]);
		expect(await receiptOf(t, storageId)).toMatchObject({
			status: 'bound',
			resourceKey: `mailSnippets:${replyId}`,
		});
	});

	it('refuses an upload that is not the caller’s', async () => {
		const t = convexTest();
		await seedMailbox(t);
		const theirs = await uploaded(t, 'secret', 'user-B');
		await expect(
			t.mutation(api.mail.savedReplies.create, {
				scope: 'personal',
				name: 'Prices',
				shortcut: '',
				bodyHtml: '<p>x</p>',
				attachments: [file(theirs)],
			})
		).rejects.toThrow(/not an unclaimed upload/);
	});

	it('deletes a file an edit drops, keeps the rest, and deletes all with the reply', async () => {
		const t = convexTest();
		await seedMailbox(t);
		const { replyId, storageId: first } = await replyWithFile(t);
		const second = await uploaded(t, 'terms');

		await t.mutation(api.mail.savedReplies.update, {
			replyId,
			attachments: [file(second, 'terms.pdf')],
		});
		expect(await blobExists(t, first)).toBe(false);
		expect(await receiptOf(t, first)).toBeNull();
		const [mine] = await t.query(api.mail.savedReplies.listMine, {});
		expect(mine?.attachments.map((a) => a.filename)).toEqual(['terms.pdf']);

		await t.mutation(api.mail.savedReplies.remove, { replyId });
		expect(await blobExists(t, second)).toBe(false);
		expect(await receiptOf(t, second)).toBeNull();
	});
});

describe('inserting a reply with files', () => {
	it('references the reply’s file instead of copying it, once', async () => {
		const t = convexTest();
		const { draftId } = await draft(t);
		const { replyId, storageId } = await replyWithFile(t);
		const blobs = await blobCount(t);

		const attachments = await t.mutation(api.mail.savedReplyAttachments.attachToDraft, {
			draftId,
			replyId,
		});
		await t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId });

		expect(attachments).toEqual([
			{
				storageId,
				filename: 'prices.pdf',
				contentType: 'application/pdf',
				size: 10,
				isInline: false,
				savedReplyId: replyId,
			},
		]);
		const row = await t.run((ctx) => ctx.db.get(draftId));
		expect(row?.attachments).toHaveLength(1);
		expect(await blobCount(t)).toBe(blobs);
	});

	it('leaves the reply’s file alone when the draft drops it or is discarded', async () => {
		const t = convexTest();
		const { draftId } = await draft(t);
		const { replyId, storageId } = await replyWithFile(t);
		await t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId });

		await t.mutation(api.mail.drafts.removeAttachment, { draftId, storageId });
		expect(await blobExists(t, storageId)).toBe(true);

		await t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId });
		await t.mutation(api.mail.drafts.discard, { draftId });
		expect(await blobExists(t, storageId)).toBe(true);
		expect(await receiptOf(t, storageId)).toMatchObject({
			resourceKey: `mailSnippets:${replyId}`,
		});
	});

	it('refuses another member’s personal reply', async () => {
		const t = convexTest();
		await seedMailbox(t);
		const { replyId } = await replyWithFile(t);
		session.userId = 'user-B';
		const mailboxId = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });

		await expect(
			t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId })
		).rejects.toThrow(/Not accessible/);
	});

	it('refuses to send once the reply no longer has the file', async () => {
		const t = convexTest();
		const { draftId } = await draft(t);
		const { replyId } = await replyWithFile(t);
		await t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId });
		await t.mutation(api.mail.drafts.update, { draftId, toAddresses: ['to@example.com'] });
		await t.mutation(api.mail.savedReplies.update, { replyId, attachments: [] });

		await expect(t.mutation(api.mail.drafts.send, { draftId })).rejects.toThrow(
			/prices\.pdf.{0,4} was removed from its saved reply/
		);
	});

	it('does not turn a borrowed file into a share link', async () => {
		const t = convexTest();
		const { draftId } = await draft(t);
		const { replyId, storageId } = await replyWithFile(t);
		await t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId });

		expect(
			await t.query(internal.mail.attachmentShares.prepareShare, { draftId, storageId })
		).toBeNull();
	});
});

describe('workspace deletion', () => {
	it('deletes a reply’s file through the reply, not through a draft that borrowed it', async () => {
		const t = convexTest();
		const { draftId } = await draft(t);
		const { replyId, storageId } = await replyWithFile(t);
		await t.mutation(api.mail.savedReplyAttachments.attachToDraft, { draftId, replyId });

		// The order of the deletion cascade: receipts, then drafts, then replies.
		await t.run(async (ctx) => {
			await storageUploadsStep.deleteBatch(ctx);
			await mailDraftsStep.deleteBatch(ctx);
		});
		expect(await blobExists(t, storageId)).toBe(true);
		await t.run((ctx) => mailSnippetsStep.deleteBatch(ctx));
		expect(await blobExists(t, storageId)).toBe(false);
		expect(await t.run((ctx) => ctx.db.get(replyId))).toBeNull();
	});
});
