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
