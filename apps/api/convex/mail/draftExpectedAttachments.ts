/**
 * Files a Postbox draft was opened to carry, owed by the draft until each one
 * is attached (#1257): the generated `.ics` an RSVP answers with, and the
 * attachments of a forwarded (or resent) message.
 *
 * WHY ON THE ROW. The composer used to hand these over in memory and upload
 * them itself. A reload while one was still uploading lost it: the reopened
 * draft had the text and not the file, and Send went out without it. Kept in
 * one tab's storage instead, another tab (or a duplicated one) still could not
 * see what was owed, and two tabs could each attach a copy. So the draft row
 * holds the debt, and every tab reads the same answer:
 *
 *  - `drafts.create` writes the owed list in the mutation that creates the row,
 *    so no draft exists without it. A generated file is stored whole (it cannot
 *    be made again, so it is bounded); a forward names the message and part.
 *  - `fulfil` (any tab, any number of times) copies each owed file onto the
 *    draft on the server. `bindExpected` settles one key exactly once: a second
 *    copy of a settled or removed key is refused and its blob deleted.
 *  - `remove` is the person taking a file out: the key is settled as removed,
 *    and a copy that already landed for it is removed with it, so a copy still
 *    in flight has nothing to come back to.
 *  - `drafts.send` refuses while a file is owed (`DRAFT_ATTACHMENTS_OWED`).
 *
 * A file that cannot be copied (its message is gone or not readable by this
 * caller, a compose limit refuses it) stays owed: the composer shows it as a
 * failed chip with Retry and Remove.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type ActionCtx, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { authedAction } from '../lib/authedFunctions';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { assertStateIs } from './draftLifecycle/reducers';
import { pickStoredPart } from './messageParts';
import { deleteOwnedUpload, storedFileSize } from '../storage/uploads';
import { getMutationContext } from '../lib/sessionOrganization';
import { openMessageBody, sealBodyAtWrite } from '../lib/messageBody';
import {
	type existingAttachmentBytesValidator,
	readExistingAttachmentBytes,
} from '../lib/existingAttachments';
import type {
	expectedAttachmentRequestValidator,
	mailDraftExpectedAttachmentValidator,
} from '../lib/validators/mailContent';
import { getOrThrow, throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';

type ExpectedAttachment = Infer<typeof mailDraftExpectedAttachmentValidator>;
type ExpectedAttachmentRequest = Infer<typeof expectedAttachmentRequestValidator>;
type ExistingAttachmentBytes = Infer<typeof existingAttachmentBytesValidator>;

/** A generated file is kept whole on the row while it is owed. An RSVP is a few KB. */
export const MAX_GENERATED_ATTACHMENT_CHARS = 64 * 1024;
/** Owed files one draft may list (a forward of a message with very many parts). */
const MAX_EXPECTED_ATTACHMENTS = 50;

/** Why an owed file was not attached this time; it stays owed. */
export type FulfilFailure = 'unreadable' | 'tooLarge' | 'tooMany' | 'totalTooLarge' | 'failed';

/**
 * The owed list for a new draft. A forward lists the message's file parts (not
 * the inline images its body shows); the caller must be able to read it.
 */
export async function expectedAttachmentsFor(
	ctx: MutationCtx,
	requests: readonly ExpectedAttachmentRequest[]
): Promise<ExpectedAttachment[]> {
	const owed: ExpectedAttachment[] = [];
	for (const [index, request] of requests.entries()) {
		if (request.kind === 'generated') {
			if (request.content.length > MAX_GENERATED_ATTACHMENT_CHARS) {
				throwInvalidInput('The generated attachment is too large');
			}
			owed.push({
				key: `generated:${index}`,
				filename: request.filename.slice(0, 255),
				contentType: request.contentType,
				size: new TextEncoder().encode(request.content).byteLength,
				// Sealed at rest like the draft's body: an RSVP names the event.
				source: { kind: 'generated', content: await sealBodyAtWrite(request.content) },
				state: 'owed',
			});
			continue;
		}
		const message = await ctx.db.get(request.messageId);
		if (!message) continue;
		const readable = await requireMailboxAccess(ctx, message.mailboxId);
		if (!readable.ok) throwForbidden('Message not accessible');
		for (const part of message.attachments) {
			if (part.contentId) continue;
			owed.push({
				key: `forward:${message._id}:${part.partIndex}`,
				filename: part.filename.slice(0, 255),
				contentType: part.contentType,
				size: part.size,
				source: { kind: 'forward', messageId: message._id, partIndex: part.partIndex },
				state: 'owed',
			});
		}
	}
	return owed.slice(0, MAX_EXPECTED_ATTACHMENTS);
}

/** `drafts.send`: nothing may go out while the draft still owes a file. */
export function assertNothingOwed(draft: Doc<'mailDrafts'>): void {
	if (draft.expectedAttachments?.some((entry) => entry.state === 'owed')) {
		throwInvalidState('An attachment is still being added to this message', {
			code: 'DRAFT_ATTACHMENTS_OWED',
		});
	}
}

/** The owed list as clients read it: a generated file's text stays on the server. */
export function expectedAttachmentsView(
	entries: readonly ExpectedAttachment[] | undefined
): ExpectedAttachment[] | undefined {
	return entries?.map((entry) =>
		entry.source.kind === 'generated' ? { ...entry, source: { kind: 'generated' } } : entry
	);
}

/** Settle one entry: its text is no longer needed once it is attached or removed. */
function settled(
	entry: ExpectedAttachment,
	state: 'attached' | 'removed',
	storageId?: Id<'_storage'>
): ExpectedAttachment {
	return {
		...entry,
		state,
		storageId,
		source: entry.source.kind === 'generated' ? { kind: 'generated' } : entry.source,
	};
}

type OwedFile =
	| {
			key: string;
			filename: string;
			contentType: string;
			bytes: { kind: 'text'; content: string } | ExistingAttachmentBytes;
	  }
	| { key: string; filename: string; unreadable: true };

/**
 * What the draft owes and where each file's bytes are, for a caller who can
 * write the draft. A forwarded part the caller cannot read is reported as such
 * (another member may be able to copy it).
 */
export const owedFiles = internalQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<OwedFile[]> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return [];
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		if (draft.state !== 'draft') return [];
		const files: OwedFile[] = [];
		for (const entry of draft.expectedAttachments ?? []) {
			if (entry.state !== 'owed') continue;
			const { key, filename, contentType, source } = entry;
			if (source.kind === 'generated') {
				if (source.content === undefined) files.push({ key, filename, unreadable: true });
				else
					files.push({
						key,
						filename,
						contentType,
						bytes: { kind: 'text', content: await openMessageBody(source.content) },
					});
				continue;
			}
			const message = await ctx.db.get(source.messageId);
			const readable = message ? await requireMailboxAccess(ctx, message.mailboxId) : null;
			if (!message || !readable?.ok) {
				files.push({ key, filename, unreadable: true });
				continue;
			}
			const parts = await ctx.db
				.query('mailMessageParts')
				.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', message.rawStorageId))
				.first();
			const part =
				parts?.status === 'stored' ? pickStoredPart(parts.parts, source.partIndex, filename) : null;
			files.push({
				key,
				filename,
				contentType,
				bytes: part
					? { kind: 'sealedPart', storageId: part.storageId }
					: {
							kind: 'rawEml',
							rawStorageId: message.rawStorageId,
							partIndex: source.partIndex,
							filename,
						},
			});
		}
		return files;
	},
});

/**
 * Put a copied blob on the draft for one owed key, exactly once. `taken` means
 * the key was already settled (another tab attached it, or the person removed
 * it): the caller deletes the blob. A compose limit leaves the key owed.
 */
export const bindExpected = internalMutation({
	args: { draftId: v.id('mailDrafts'), key: v.string(), storageId: v.id('_storage') },
	handler: async (
		ctx,
		args
	): Promise<{ outcome: 'bound' | 'taken' | 'tooLarge' | 'tooMany' | 'totalTooLarge' }> => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const entries = draft.expectedAttachments ?? [];
		const entry = entries.find((e) => e.key === args.key);
		if (!entry || entry.state !== 'owed') return { outcome: 'taken' };
		if (draft.attachments.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
			return { outcome: 'tooMany' };
		}
		const size = await storedFileSize(ctx, args.storageId);
		if (size > MAX_ATTACHMENT_BYTES) return { outcome: 'tooLarge' };
		const existing = await Promise.all(
			draft.attachments.map((attachment) => storedFileSize(ctx, attachment.storageId))
		);
		if (
			existing.reduce((total, bytes) => total + bytes, size) >
			ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes
		) {
			return { outcome: 'totalTooLarge' };
		}
		// Bound to the draft like an upload, so discard and send free it.
		const session = await getMutationContext(ctx);
		await ctx.db.insert('storageUploads', {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			status: 'bound',
			storageId: args.storageId,
			resourceKey: `mailDrafts:${args.draftId}`,
		});
		await ctx.db.patch(args.draftId, {
			attachments: [
				...draft.attachments,
				{
					storageId: args.storageId,
					filename: entry.filename,
					contentType: entry.contentType,
					size,
					isInline: false,
				},
			],
			expectedAttachments: entries.map((e) =>
				e.key === args.key ? settled(e, 'attached', args.storageId) : e
			),
			lastEditedAt: Date.now(),
		});
		return { outcome: 'bound' };
	},
});

/**
 * Copy every file the draft owes onto it. Safe to run from any number of tabs
 * at once: each key is bound once and a losing copy is deleted. Returns the
 * keys that stay owed and why.
 */
export async function fulfilExpectedAttachments(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'storage'>,
	args: { draftId: Id<'mailDrafts'> }
): Promise<{ failed: Array<{ key: string; filename: string; reason: FulfilFailure }> }> {
	const owed: OwedFile[] = await ctx.runQuery(
		internal.mail.draftExpectedAttachments.owedFiles,
		args
	);
	const failed: Array<{ key: string; filename: string; reason: FulfilFailure }> = [];
	for (const file of owed) {
		if ('unreadable' in file) {
			failed.push({ key: file.key, filename: file.filename, reason: 'unreadable' });
			continue;
		}
		const bytes =
			file.bytes.kind === 'text'
				? new TextEncoder().encode(file.bytes.content)
				: await readExistingAttachmentBytes(ctx.storage, file.bytes).catch(() => null);
		if (!bytes || bytes.byteLength === 0) {
			failed.push({ key: file.key, filename: file.filename, reason: 'unreadable' });
			continue;
		}
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			failed.push({ key: file.key, filename: file.filename, reason: 'tooLarge' });
			continue;
		}
		const storageId = await ctx.storage.store(
			new Blob([bytes as BlobPart], { type: file.contentType })
		);
		let outcome: 'bound' | 'taken' | 'tooLarge' | 'tooMany' | 'totalTooLarge' | 'failed';
		try {
			({ outcome } = await ctx.runMutation(internal.mail.draftExpectedAttachments.bindExpected, {
				draftId: args.draftId,
				key: file.key,
				storageId,
			}));
		} catch {
			outcome = 'failed';
		}
		if (outcome === 'bound') continue;
		await ctx.storage.delete(storageId);
		if (outcome !== 'taken')
			failed.push({ key: file.key, filename: file.filename, reason: outcome });
	}
	return { failed };
}

/**
 * Copy what the draft owes onto it (the composer runs this whenever a draft it
 * shows owes a file; another tab running it too is harmless).
 */
// authz: owedFiles checks the caller can write the draft (and read each forwarded message); bindExpected re-checks the draft.
export const fulfil = authedAction({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args) => fulfilExpectedAttachments(ctx, args),
});

/**
 * The person takes an owed (or already attached) file out. Settles the key as
 * removed, so a copy still in flight is refused, and removes a copy that
 * already landed.
 */
export const remove = postboxMutation({
	args: { draftId: v.id('mailDrafts'), key: v.string() },
	handler: async (ctx, args) => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const entries = draft.expectedAttachments ?? [];
		const entry = entries.find((e) => e.key === args.key);
		if (!entry || entry.state === 'removed') return { ok: true };
		const landed = entry.storageId;
		await ctx.db.patch(args.draftId, {
			attachments: landed
				? draft.attachments.filter((a) => a.storageId !== landed)
				: draft.attachments,
			expectedAttachments: entries.map((e) => (e.key === args.key ? settled(e, 'removed') : e)),
			lastEditedAt: Date.now(),
		});
		if (landed && draft.attachments.some((a) => a.storageId === landed)) {
			await deleteOwnedUpload(ctx, landed, `mailDrafts:${args.draftId}`);
		}
		return { ok: true };
	},
});
