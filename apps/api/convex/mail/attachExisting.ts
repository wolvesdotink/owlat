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
 * inbox reply): a `mailAttachments` row only from a mailbox the caller can
 * read. A reply narrows Files further: a `semanticFiles` row only when it is
 * org-general or linked to a contact the draft is addressed to, the contact
 * scope the drafting path retrieves under, so a reply to contact A cannot
 * carry contact B's invoice.
 *
 * A mutation cannot read blob bytes, so the public entry is an action
 * (`mail.drafts.attachExisting`) that copies synchronously and returns the
 * draft's attachments, over the internal query and mutation here.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type ActionCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { normalizeEmail } from '@owlat/shared';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { requireMailboxAccess } from './permissions';
import { assertStateIs } from './draftLifecycle/reducers';
import { storedFileSize } from '../storage/uploads';
import { findContactByIdentifier } from '../contacts/resolution';
import { isContactScopeVisible } from '../lib/contactScope';
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

/** The contacts a draft is addressed to, for the Files contact scope. */
async function recipientContactIds(
	ctx: QueryCtx,
	draft: Doc<'mailDrafts'>
): Promise<Id<'contacts'>[]> {
	const ids: Id<'contacts'>[] = [];
	const addresses = [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses];
	for (const address of addresses.slice(0, 20)) {
		const identifier = normalizeEmail(address);
		if (!identifier) continue;
		const found = await findContactByIdentifier(ctx, 'email', identifier);
		if (found && !ids.includes(found.contact._id)) ids.push(found.contact._id);
	}
	return ids;
}

/**
 * The shared read check (lib/existingAttachments.ts: any member reads Files, a
 * mail attachment needs its mailbox), narrowed for a reply: a Files row must
 * also be org-general or linked to one of `contactIds`, the scope the drafting
 * path retrieves under. Throws forbidden / not found.
 */
async function resolveInScope(
	ctx: QueryCtx,
	source: AttachExistingSource,
	id: string,
	contactIds: readonly Id<'contacts'>[]
): Promise<ExistingAttachment> {
	const session = await requireOrgMember(ctx);
	const resolved = await resolveReadableExistingAttachment(ctx, { source, id }, session);
	if (resolved.source === 'semanticFile') {
		const file = await ctx.db.get(resolved.id as Id<'semanticFiles'>);
		const visible =
			isContactScopeVisible(file?.contactIds, 'org-general-only') ||
			contactIds.some((contactId) => isContactScopeVisible(file?.contactIds, contactId));
		if (!visible) throwForbidden('This file belongs to another contact');
	}
	return resolved;
}

/** Resolve a source for a draft the caller can write. */
export const resolveForDraft = internalQuery({
	args: {
		draftId: v.id('mailDrafts'),
		source: existingAttachmentSourceValidator,
		id: v.string(),
	},
	handler: async (ctx, args): Promise<ExistingAttachment> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwNotFound('Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		return await resolveInScope(ctx, args.source, args.id, await recipientContactIds(ctx, draft));
	},
});

/**
 * Check a source is readable under an explicit contact scope and return its
 * filename. For file answers that are not attached here (a team-thread reply,
 * where the team inbox attaches them).
 */
export const resolveReadableFile = internalQuery({
	args: {
		source: existingAttachmentSourceValidator,
		id: v.string(),
		contactId: v.optional(v.id('contacts')),
	},
	handler: async (ctx, args): Promise<{ filename: string }> => {
		const resolved = await resolveInScope(
			ctx,
			args.source,
			args.id,
			args.contactId ? [args.contactId] : []
		);
		return { filename: resolved.filename };
	},
});

/**
 * Attachment rows of one mailbox whose filename matches, for the Answer mode
 * file search (inbox/attachmentSuggest.ts searchFilesForRequest). Empty when
 * the caller cannot read the mailbox.
 */
export const searchMailboxAttachments = internalQuery({
	args: { mailboxId: v.id('mailboxes'), queryText: v.string(), limit: v.number() },
	handler: async (
		ctx,
		args
	): Promise<Array<{ id: string; filename: string; contentType: string; size: number }>> => {
		const readable = await requireMailboxAccess(ctx, args.mailboxId);
		if (!readable.ok) return [];
		const rows = await ctx.db
			.query('mailAttachments')
			.withSearchIndex('search_filenames', (q) =>
				q.search('filename', args.queryText).eq('mailboxId', args.mailboxId)
			)
			.take(Math.min(Math.max(args.limit, 1), 20));
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
 * free it like any upload. The caller deletes the blob when this throws.
 */
export const bindCopiedAttachment = internalMutation({
	args: {
		draftId: v.id('mailDrafts'),
		storageId: v.id('_storage'),
		filename: v.string(),
		contentType: v.string(),
	},
	handler: async (ctx, args): Promise<DraftAttachment[]> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwNotFound('Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
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
			},
		];
		await ctx.db.patch(args.draftId, { attachments, lastEditedAt: Date.now() });
		return attachments;
	},
});

/**
 * Copy an existing file onto a draft the caller can write and return the
 * draft's attachments. Shared by `mail.drafts.attachExisting` and the Answer
 * mode file answers (mail/ai/composeDraft.ts).
 */
export async function copyExistingIntoDraft(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'storage'>,
	args: { draftId: Id<'mailDrafts'>; source: AttachExistingSource; id: string }
): Promise<{ attachments: DraftAttachment[]; filename: string }> {
	const resolved: ExistingAttachment = await ctx.runQuery(
		internal.mail.attachExisting.resolveForDraft,
		args
	);
	const bytes = await readExistingAttachmentBytes(ctx.storage, resolved.bytes);
	if (!bytes || bytes.byteLength === 0) throwInvalidState('The file could not be read');
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throwInvalidInput('Attachment size exceeds the allowed limit');
	}
	const storageId = await ctx.storage.store(
		new Blob([bytes as BlobPart], { type: resolved.contentType })
	);
	try {
		const attachments: DraftAttachment[] = await ctx.runMutation(
			internal.mail.attachExisting.bindCopiedAttachment,
			{
				draftId: args.draftId,
				storageId,
				filename: resolved.filename,
				contentType: resolved.contentType,
			}
		);
		return { attachments, filename: resolved.filename };
	} catch (err) {
		await ctx.storage.delete(storageId);
		throw err;
	}
}
