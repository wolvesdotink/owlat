/**
 * Attach a file that already exists (a Files row or an earlier email's
 * attachment) to a Postbox draft, without the download-and-reupload that
 * `drafts.addAttachment` forces.
 *
 * WHY A COPY, NOT A REFERENCE. A draft owns its attachment blobs: discard and
 * send free them through the draft's upload receipt, and member erasure and
 * workspace deletion delete them outright. Pointing a draft at a shared blob
 * would let those paths delete a Files row's bytes or an inbound message's
 * part, and the other direction is just as bad: the Files retention sweep, a
 * file delete or a message purge would pull the bytes out from under a draft,
 * which then sends without them. Mail attachment parts are also sealed at
 * rest, so a reference would ship ciphertext. So the bytes are read (unsealed),
 * stored as a new blob the draft owns through a bound upload receipt, and from
 * then on the copy lives and dies with the draft exactly like an upload.
 *
 * ACCESS. The caller must be able to write the draft (its mailbox) and pass
 * the shared read check in lib/existingAttachments.ts (also used by the team
 * inbox reply and the file answers): a `mailAttachments` row only from a
 * mailbox the caller can read, any Files row the caller could open on the
 * Files page. There is no contact narrowing here: contact scope bounds what
 * the AI retrieves on its own (the file search is contact-scoped), while this
 * is a person's explicit pick of a file they can already download.
 *
 * A mutation cannot read blob bytes, so the public entry is an action
 * (`mail.drafts.attachExisting`) that copies synchronously and returns the
 * draft's attachments, over the internal query and mutation here.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type ActionCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { requireMailboxAccess } from './permissions';
import { assertStateIs } from './draftLifecycle/reducers';
import { storedFileSize } from '../storage/uploads';
import { extractEmail } from '../lib/emailAddress';
import { mailboxAttachmentScopeValidator } from '../lib/validators/answerAsk';
import { getMutationContext, requireOrgMember } from '../lib/sessionOrganization';
import {
	existingAttachmentSourceValidator,
	readExistingAttachmentBytes,
	resolveReadableExistingAttachment,
	type ExistingAttachment,
} from '../lib/existingAttachments';
import {
	throwForbidden,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';
import type { mailDraftAttachmentValidator } from '../lib/validators/mailContent';

type AttachExistingSource = Infer<typeof existingAttachmentSourceValidator>;
type DraftAttachment = Infer<typeof mailDraftAttachmentValidator>;

/** Whether the draft already holds a copy of this file. */
function hasCopyOf(
	attachments: readonly DraftAttachment[],
	source: AttachExistingSource,
	id: string
): boolean {
	return attachments.some((a) => a.copiedFrom?.source === source && a.copiedFrom.id === id);
}

/**
 * Resolve a source for a draft the caller can write. `attached` is the draft's
 * list when it already holds a copy of the file (nothing to do), and a file
 * over the per-file limit is refused here, before an action reads its bytes.
 */
export const resolveForDraft = internalQuery({
	args: {
		draftId: v.id('mailDrafts'),
		source: existingAttachmentSourceValidator,
		id: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<{ file: ExistingAttachment; attached?: DraftAttachment[] }> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwNotFound('Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const session = await requireOrgMember(ctx);
		const file = await resolveReadableExistingAttachment(ctx, args, session);
		if (hasCopyOf(draft.attachments, file.source, file.id)) {
			return { file, attached: draft.attachments };
		}
		if (draft.attachments.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
			throwInvalidInput('Too many attachments');
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			throwInvalidInput('Attachment size exceeds the allowed limit');
		}
		return { file };
	},
});

/**
 * Check a source is readable and return its filename. For file answers that
 * are not attached here (a team-thread reply, where the team inbox attaches
 * them).
 */
export const resolveReadableFile = internalQuery({
	args: { source: existingAttachmentSourceValidator, id: v.string() },
	handler: async (ctx, args): Promise<{ filename: string }> => {
		const session = await requireOrgMember(ctx);
		const resolved = await resolveReadableExistingAttachment(ctx, args, session);
		return { filename: resolved.filename };
	},
});

/** Rows the filename search reads before the scope filter keeps the counterpart's. */
const MAILBOX_SEARCH_WINDOW = 50;

function bareAddress(value: string): string {
	return extractEmail(value).toLowerCase();
}

/**
 * Attachment rows whose filename matches, for the Answer mode file search
 * (inbox/attachmentSuggest.ts searchFilesForRequest), limited to the scope:
 * attachments of messages in the reply's thread, or of messages from or to the
 * counterpart. A file another customer sent or was sent never comes back, not
 * even as a candidate, since its name alone would disclose it. This search runs
 * without a person choosing anything, and its single best hit is attached
 * without a question. Empty when the caller cannot read the mailbox.
 */
export const searchMailboxAttachments = internalQuery({
	args: {
		scope: mailboxAttachmentScopeValidator,
		queryText: v.string(),
		limit: v.number(),
	},
	handler: async (
		ctx,
		args
	): Promise<Array<{ id: string; filename: string; contentType: string; size: number }>> => {
		const { mailboxId, threadId } = args.scope;
		const counterparts = new Set(args.scope.counterparts.map(bareAddress).filter(Boolean));
		if (!threadId && counterparts.size === 0) return [];
		const readable = await requireMailboxAccess(ctx, mailboxId);
		if (!readable.ok) return [];
		const hits = await ctx.db
			.query('mailAttachments')
			.withSearchIndex('search_filenames', (q) =>
				q.search('filename', args.queryText).eq('mailboxId', mailboxId)
			)
			.take(MAILBOX_SEARCH_WINDOW);
		const limit = Math.min(Math.max(args.limit, 1), 20);
		const rows = [];
		for (const row of hits) {
			if (rows.length >= limit) break;
			const message = await ctx.db.get(row.messageId);
			if (!message || message.mailboxId !== mailboxId) continue;
			const people = [message.fromAddress, ...message.toAddresses, ...message.ccAddresses];
			const inScope =
				(threadId !== undefined && message.threadId === threadId) ||
				people.some((address) => counterparts.has(bareAddress(address)));
			if (inScope) rows.push(row);
		}
		return rows.map((row) => ({
			id: row._id,
			filename: row.filename,
			contentType: row.contentType,
			size: row.size,
		}));
	},
});

/**
 * Put a copied blob on the draft. Re-checks access and the draft state (the
 * bytes were read in between), enforces the composer's count and size limits,
 * and binds the blob to the draft with an upload receipt so discard and send
 * free it like any upload. The caller deletes the blob when this throws, or
 * when `isBound` is false: a concurrent attach put the same file on first.
 */
export const bindCopiedAttachment = internalMutation({
	args: {
		draftId: v.id('mailDrafts'),
		storageId: v.id('_storage'),
		filename: v.string(),
		contentType: v.string(),
		copiedFrom: v.object({ source: existingAttachmentSourceValidator, id: v.string() }),
	},
	handler: async (ctx, args): Promise<{ attachments: DraftAttachment[]; isBound: boolean }> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwNotFound('Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		if (hasCopyOf(draft.attachments, args.copiedFrom.source, args.copiedFrom.id)) {
			return { attachments: draft.attachments, isBound: false };
		}
		if (draft.attachments.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
			throwInvalidInput('Too many attachments');
		}
		const size = await storedFileSize(ctx, args.storageId);
		const existing = await Promise.all(
			draft.attachments.map((attachment) => storedFileSize(ctx, attachment.storageId))
		);
		if (
			existing.reduce((total, bytes) => total + bytes, size) >
			ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes
		) {
			throwInvalidInput('Attachments exceed the total size limit');
		}
		const session = await getMutationContext(ctx);
		await ctx.db.insert('storageUploads', {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			status: 'bound',
			storageId: args.storageId,
			resourceKey: `mailDrafts:${args.draftId}`,
		});
		const attachments: DraftAttachment[] = [
			...draft.attachments,
			{
				storageId: args.storageId,
				filename: args.filename.slice(0, 255),
				contentType: args.contentType,
				size,
				isInline: false,
				copiedFrom: args.copiedFrom,
			},
		];
		await ctx.db.patch(args.draftId, { attachments, lastEditedAt: Date.now() });
		return { attachments, isBound: true };
	},
});

/**
 * Copy an existing file onto a draft the caller can write and return the
 * draft's attachments. Shared by `mail.drafts.attachExisting` and the Answer
 * mode file answers (mail/ai/composeDraft.ts). A file the draft already holds
 * a copy of is not copied again, so running "Draft with AI" twice or tapping
 * a file twice leaves one attachment.
 */
export async function copyExistingIntoDraft(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'storage'>,
	args: { draftId: Id<'mailDrafts'>; source: AttachExistingSource; id: string }
): Promise<{ attachments: DraftAttachment[]; filename: string }> {
	const { file, attached }: { file: ExistingAttachment; attached?: DraftAttachment[] } =
		await ctx.runQuery(internal.mail.attachExisting.resolveForDraft, args);
	if (attached) return { attachments: attached, filename: file.filename };
	const bytes = await readExistingAttachmentBytes(ctx.storage, file.bytes);
	if (!bytes || bytes.byteLength === 0) throwInvalidState('The file could not be read');
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throwInvalidInput('Attachment size exceeds the allowed limit');
	}
	const storageId = await ctx.storage.store(
		new Blob([bytes as BlobPart], { type: file.contentType })
	);
	let bound: { attachments: DraftAttachment[]; isBound: boolean };
	try {
		bound = await ctx.runMutation(internal.mail.attachExisting.bindCopiedAttachment, {
			draftId: args.draftId,
			storageId,
			filename: file.filename,
			contentType: file.contentType,
			copiedFrom: { source: file.source, id: file.id },
		});
	} catch (err) {
		await ctx.storage.delete(storageId);
		throw err;
	}
	if (!bound.isBound) await ctx.storage.delete(storageId);
	return { attachments: bound.attachments, filename: file.filename };
}
