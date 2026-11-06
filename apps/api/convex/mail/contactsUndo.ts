/**
 * The Undo of removing an address-book row (`contacts.remove`): the row's
 * picture outlives it for a short window, and `restore` puts the row back as
 * the contacts page held it, picture included while it is still kept.
 */

import { v } from 'convex/values';
import { normalizeVcardImportEntry } from '@owlat/shared/postboxVcard';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import {
	mailContactCardDavSourceValidator,
	mailContactPhoneValidator,
	mailContactPostalAddressValidator,
} from '../lib/validators/mailContacts';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { voidColdPitchVerdictsOfSender } from './arrival/coldPitch';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { loadSenderContact } from './senderEvidence';

/**
 * How long a removed contact's picture outlives its row. Longer than the
 * toast that offers the Undo stays up.
 */
const REMOVED_PHOTO_GRACE_MS = 60 * 1000;
const REMOVED_PHOTO_JOB = 'mail/contactsUndo:_deleteRemovedContactPhoto';

/** Delete a removed row's picture once the Undo window closes; returns the job `restore` cancels. */
export async function scheduleRemovedPhotoDeletion(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	storageId: Id<'_storage'>
): Promise<Id<'_scheduled_functions'>> {
	return ctx.scheduler.runAfter(
		REMOVED_PHOTO_GRACE_MS,
		internal.mail.contactsUndo._deleteRemovedContactPhoto,
		{ mailboxId, storageId }
	);
}

/** The picture of a removed contact, once nobody restored the row in time. */
export const _deleteRemovedContactPhoto = internalMutation({
	// `mailboxId` is what `restore` checks a reclaimed picture against.
	args: { mailboxId: v.id('mailboxes'), storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		await deleteBlobQuietly(ctx.storage, args.storageId, '[mail contacts]', {
			mailboxId: args.mailboxId,
		});
	},
});

/**
 * Take back the picture of a removed row: only a blob whose pending deletion
 * this mailbox's `remove` scheduled, so a caller cannot attach any other blob.
 */
async function reclaimRemovedPhoto(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	storageId: Id<'_storage'> | undefined,
	removalId: Id<'_scheduled_functions'> | undefined
): Promise<Id<'_storage'> | undefined> {
	if (!storageId || !removalId) return undefined;
	const job = await ctx.db.system.get(removalId);
	if (!job || job.state.kind !== 'pending') return undefined;
	if (job.name.replace(/\.js(?=:)/, '') !== REMOVED_PHOTO_JOB) return undefined;
	const [jobArgs] = job.args as Array<{ mailboxId?: string; storageId?: string } | undefined>;
	if (jobArgs?.mailboxId !== mailboxId || jobArgs.storageId !== storageId) return undefined;
	await ctx.scheduler.cancel(removalId);
	return storageId;
}

/**
 * Put a removed row back as it was: the Undo of `remove`. The details are
 * bounded like an import's; the picture comes back only while its deletion is
 * still pending, and the CardDAV link only to an account of this mailbox. An
 * address that has a row again (a second Undo) is left as it is.
 */
// authz: mailbox access via requireMailboxAccess; org membership via authedMutation.
export const restore = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		contact: v.object({
			email: v.string(),
			displayName: v.optional(v.string()),
			organization: v.optional(v.string()),
			phones: v.optional(v.array(mailContactPhoneValidator)),
			postalAddresses: v.optional(v.array(mailContactPostalAddressValidator)),
			photoStorageId: v.optional(v.id('_storage')),
			importedAt: v.optional(v.number()),
			cardDavSource: v.optional(mailContactCardDavSourceValidator),
			isVip: v.optional(v.boolean()),
			isScreenerAccepted: v.optional(v.boolean()),
			useCount: v.number(),
			lastUsedAt: v.number(),
			createdAt: v.number(),
		}),
		photoRemovalId: v.optional(v.id('_scheduled_functions')),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const { contact } = args;
		const entry = normalizeVcardImportEntry(contact);
		if (!entry) throwInvalidInput('Invalid email');
		const existing = await loadSenderContact(ctx, args.mailboxId, entry.email);
		if (existing) return existing._id;
		const account = contact.cardDavSource
			? await ctx.db.get(contact.cardDavSource.accountId)
			: null;
		const photoStorageId = await reclaimRemovedPhoto(
			ctx,
			args.mailboxId,
			contact.photoStorageId,
			args.photoRemovalId
		);
		await voidColdPitchVerdictsOfSender(ctx, args.mailboxId, entry.email);
		return ctx.db.insert('mailContacts', {
			...entry,
			mailboxId: args.mailboxId,
			photoStorageId,
			importedAt: contact.importedAt,
			cardDavSource: account?.mailboxId === args.mailboxId ? contact.cardDavSource : undefined,
			isVip: contact.isVip,
			isScreenerAccepted: contact.isScreenerAccepted,
			useCount: Math.max(0, Math.floor(contact.useCount)),
			lastUsedAt: contact.lastUsedAt,
			createdAt: contact.createdAt,
		});
	},
});
