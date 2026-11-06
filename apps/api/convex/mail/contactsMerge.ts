/**
 * Writing an imported address-book entry into `mailContacts`: the merge that a
 * vCard import (`contactsVcard.ts`) and a CardDAV sync (`contactsCardDav.ts`)
 * share, so the two agree on what an existing row keeps.
 *
 * Merging is by address. A row the mail already built keeps its name,
 * organization, picture and use counts; the import fills what is missing and
 * adds phone numbers and postal addresses. A new row counts as an address-book
 * entry everywhere else (screener, cold-pitch verdicts) with `useCount` 0,
 * because nobody has been written to yet.
 *
 * A row a CardDAV sync inserted is the card's copy, so a later version of the
 * same card replaces its details instead of merging into them. Editing the row
 * (`contacts.upsert`) ends that: the row is the person's from then on.
 */

import {
	mergeVcardAddresses,
	mergeVcardPhones,
	type VcardContactEntry,
} from '@owlat/shared/postboxVcard';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import { loadSenderContact } from './senderEvidence';
import { voidColdPitchVerdictsOfSender } from './arrival/coldPitch';

export type ContactSource =
	| { kind: 'vcard' }
	| {
			kind: 'carddav';
			accountId: Id<'mailCardDavAccounts'>;
			href: string;
			etag: string;
	  };

export interface WriteEntryOutcome {
	outcome: 'created' | 'merged';
	/** Whether the row took `photoStorageId`; when not, the caller still owns the blob. */
	isPhotoUsed: boolean;
}

function isSyncCopy(row: Doc<'mailContacts'>, source: ContactSource): boolean {
	return (
		source.kind === 'carddav' &&
		row.cardDavSource?.accountId === source.accountId &&
		row.cardDavSource.isRowCreatedBySync
	);
}

/**
 * The link a merged row keeps: an unlinked row joins the syncing account, a
 * row of the same account follows the card's new etag, and a row another
 * account's sync created stays linked to that account.
 */
function mergedSourceLink(
	existing: Doc<'mailContacts'>,
	source: ContactSource
): Pick<Doc<'mailContacts'>, 'cardDavSource'> | Record<string, never> {
	if (source.kind !== 'carddav') return {};
	const { accountId, href, etag } = source;
	if (!existing.cardDavSource) {
		return { cardDavSource: { accountId, href, etag, isRowCreatedBySync: false } };
	}
	if (existing.cardDavSource.accountId !== accountId) return {};
	return { cardDavSource: { ...existing.cardDavSource, href, etag } };
}

/**
 * Write one normalized entry. `photoStorageId` is a picture the caller stored
 * for this entry; a row that already has one keeps it, unless it is the sync's
 * own copy of the card.
 */
export async function writeAddressBookEntry(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	entry: VcardContactEntry,
	source: ContactSource,
	now: number,
	photoStorageId?: Id<'_storage'>
): Promise<WriteEntryOutcome> {
	const existing = await loadSenderContact(ctx, mailboxId, entry.email);
	if (existing && isSyncCopy(existing, source) && source.kind === 'carddav') {
		if (existing.photoStorageId && existing.photoStorageId !== photoStorageId) {
			await deleteBlobQuietly(ctx.storage, existing.photoStorageId, '[mail contacts]', {
				contactId: existing._id,
			});
		}
		await ctx.db.patch(existing._id, {
			displayName: entry.displayName,
			organization: entry.organization,
			phones: entry.phones,
			postalAddresses: entry.postalAddresses,
			photoStorageId,
			cardDavSource: { ...existing.cardDavSource!, href: source.href, etag: source.etag },
		});
		return { outcome: 'merged', isPhotoUsed: photoStorageId !== undefined };
	}
	if (existing) {
		const phones = mergeVcardPhones(existing.phones, entry.phones);
		const postalAddresses = mergeVcardAddresses(existing.postalAddresses, entry.postalAddresses);
		const isPhotoUsed = !existing.photoStorageId && photoStorageId !== undefined;
		await ctx.db.patch(existing._id, {
			displayName: existing.displayName ?? entry.displayName,
			organization: existing.organization ?? entry.organization,
			phones: phones.length > 0 ? phones : undefined,
			postalAddresses: postalAddresses.length > 0 ? postalAddresses : undefined,
			...(isPhotoUsed ? { photoStorageId } : {}),
			...(source.kind === 'vcard' ? { importedAt: now } : {}),
			...mergedSourceLink(existing, source),
		});
		return { outcome: 'merged', isPhotoUsed };
	}
	await voidColdPitchVerdictsOfSender(ctx, mailboxId, entry.email);
	await ctx.db.insert('mailContacts', {
		mailboxId,
		email: entry.email,
		displayName: entry.displayName,
		organization: entry.organization,
		phones: entry.phones,
		postalAddresses: entry.postalAddresses,
		photoStorageId,
		useCount: 0,
		lastUsedAt: now,
		...(source.kind === 'vcard' ? { importedAt: now } : {}),
		...(source.kind === 'carddav'
			? {
					cardDavSource: {
						accountId: source.accountId,
						href: source.href,
						etag: source.etag,
						isRowCreatedBySync: true,
					},
				}
			: {}),
		createdAt: now,
	});
	return { outcome: 'created', isPhotoUsed: photoStorageId !== undefined };
}

/**
 * Take a row out of a CardDAV account: the card was removed, no longer lists
 * the address, or the account was disconnected. A row the sync inserted and
 * nobody has written to since goes, with its picture. A row that existed
 * before the sync, or that mail has used since, stays and loses the link.
 */
export async function detachSyncedRow(ctx: MutationCtx, row: Doc<'mailContacts'>): Promise<void> {
	if (row.cardDavSource?.isRowCreatedBySync && row.useCount === 0 && !row.isVip) {
		await deleteContactRow(ctx, row);
		return;
	}
	await ctx.db.patch(row._id, { cardDavSource: undefined });
}

/** Delete an address-book row and the picture it owns. */
export async function deleteContactRow(ctx: MutationCtx, row: Doc<'mailContacts'>): Promise<void> {
	if (row.photoStorageId) {
		await deleteBlobQuietly(ctx.storage, row.photoStorageId, '[mail contacts]', {
			contactId: row._id,
		});
	}
	await ctx.db.delete(row._id);
}
