/**
 * The vCard details a Postbox address-book row (`mailContacts`) carries. One
 * source for the schema and the import mutation's args; the bounds on every
 * field live with the parser in `@owlat/shared/postboxVcard`.
 */

import { v } from 'convex/values';
import { VCARD_ADDRESS_TYPES, VCARD_PHONE_TYPES } from '@owlat/shared/postboxVcard';
import { literalUnion } from '../literalUnion';

export const mailContactPhoneValidator = v.object({
	value: v.string(),
	type: v.optional(literalUnion(VCARD_PHONE_TYPES)),
});

export const mailContactPostalAddressValidator = v.object({
	type: v.optional(literalUnion(VCARD_ADDRESS_TYPES)),
	poBox: v.optional(v.string()),
	extended: v.optional(v.string()),
	street: v.optional(v.string()),
	locality: v.optional(v.string()),
	region: v.optional(v.string()),
	postalCode: v.optional(v.string()),
	country: v.optional(v.string()),
});

export const mailContactImportEntryValidator = v.object({
	email: v.string(),
	displayName: v.optional(v.string()),
	organization: v.optional(v.string()),
	phones: v.optional(v.array(mailContactPhoneValidator)),
	postalAddresses: v.optional(v.array(mailContactPostalAddressValidator)),
});

/**
 * Where a CardDAV-synced address-book row came from: the account, the card's
 * URL and the etag it had when the row was written. `isRowCreatedBySync` tells
 * a row the sync inserted from one it merged into (built from mail or a vCard
 * import first, or edited by a person since), which a removal of the card or a
 * disconnect leaves in place and a changed card only merges into.
 *
 * `editedAt` marks a sync copy a person edited, which stopped it following the
 * card; `contactsCardDav.resumeCardDavUpdates` hands it back. An empty `etag`
 * makes the next sync fetch the card whether or not the server changed it.
 */
export const mailContactCardDavSourceValidator = v.object({
	accountId: v.id('mailCardDavAccounts'),
	href: v.string(),
	etag: v.string(),
	isRowCreatedBySync: v.boolean(),
	editedAt: v.optional(v.number()),
});

/** How the last CardDAV sync of an account went. */
export const mailCardDavSyncStatusValidator = v.union(
	v.literal('pending'),
	v.literal('ok'),
	v.literal('error')
);

/**
 * Why connecting or syncing a CardDAV book failed: the server refused the
 * credentials, could not be reached (or is not a public host), did not answer
 * as CardDAV, has no address book, sent more than a sync reads, or failed
 * another way.
 */
export const CARDDAV_ERROR_CODES = [
	'auth',
	'unreachable',
	'not_carddav',
	'no_address_book',
	'too_large',
	'failed',
] as const;
export type CardDavErrorCode = (typeof CARDDAV_ERROR_CODES)[number];
export const mailCardDavErrorCodeValidator = literalUnion(CARDDAV_ERROR_CODES);
