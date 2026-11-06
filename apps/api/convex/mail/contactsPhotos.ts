/**
 * Pictures of a vCard import. The browser parses the .vcf file and writes its
 * entries with `contactsVcard.importBatch`; a mutation cannot put bytes in file
 * storage, so the entries' pictures follow through `importPhotos`, a few at a
 * time. A row that already has a picture keeps it, as the merge keeps a name.
 *
 * Every picture is checked again here with the parser's own bounds
 * (`normalizeVcardPhoto`): base64, at most `VCARD_MAX_PHOTO_BYTES`, and a
 * raster format read from the bytes. Nothing else reaches storage.
 */

import { v } from 'convex/values';
import { normalizeEmail } from '@owlat/shared';
import { VCARD_PHOTO_BATCH_SIZE, normalizeVcardPhoto } from '@owlat/shared/postboxVcard';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { internalMutation } from '../lib/writeFence';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { loadSenderContact } from './senderEvidence';

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The action's access check, before it stores anything. */
export const _canWriteBook = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => (await requireMailboxAccess(ctx, args.mailboxId)).ok,
});

/** Store the pictures of imported entries and give each to its row. */
// authz: authedAction (authenticated member); mailbox access via internal._canWriteBook
// before storing and again in internal._attachImportedPhotos.
export const importPhotos = authedAction({
	args: {
		mailboxId: v.id('mailboxes'),
		photos: v.array(v.object({ email: v.string(), base64: v.string() })),
	},
	handler: async (ctx, args): Promise<{ attached: number }> => {
		if (args.photos.length > VCARD_PHOTO_BATCH_SIZE) {
			throwInvalidInput(`At most ${VCARD_PHOTO_BATCH_SIZE} pictures per batch`);
		}
		const canWrite: boolean = await ctx.runQuery(internal.mail.contactsPhotos._canWriteBook, {
			mailboxId: args.mailboxId,
		});
		if (!canWrite) throwForbidden('Mailbox not accessible');
		const stored: Array<{ email: string; storageId: Id<'_storage'> }> = [];
		for (const { email, base64 } of args.photos) {
			const photo = normalizeVcardPhoto(base64);
			if (!photo) continue;
			const storageId = await ctx.storage.store(
				new Blob([decodeBase64(photo.base64)], { type: photo.mediaType })
			);
			stored.push({ email: normalizeEmail(email.trim()), storageId });
		}
		if (stored.length === 0) return { attached: 0 };
		return await ctx.runMutation(internal.mail.contactsPhotos._attachImportedPhotos, {
			mailboxId: args.mailboxId,
			photos: stored,
		});
	},
});

/** Give each stored picture to its row when the row has none; delete the rest. */
export const _attachImportedPhotos = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		photos: v.array(v.object({ email: v.string(), storageId: v.id('_storage') })),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		let attached = 0;
		for (const { email, storageId } of args.photos) {
			const row = owned.ok ? await loadSenderContact(ctx, args.mailboxId, email) : null;
			if (row && !row.photoStorageId) {
				await ctx.db.patch(row._id, { photoStorageId: storageId });
				attached++;
				continue;
			}
			await deleteBlobQuietly(ctx.storage, storageId, '[mail contacts]', { email });
		}
		return { attached };
	},
});
