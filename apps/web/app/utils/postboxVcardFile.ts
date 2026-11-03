/**
 * The file decisions of the Postbox address book's vCard import and export.
 * Pure, so they are testable without a DOM; the picking, reading and writing
 * is `usePostboxVcardTransfer`.
 */

import { VCARD_MAX_FILE_BYTES, type VcardContactEntry } from '@owlat/shared/postboxVcard';

export type VcardFileRejection = 'too_large' | 'wrong_type';

const VCARD_EXTENSIONS = ['.vcf', '.vcard'];
const VCARD_MIME_TYPES = new Set(['text/vcard', 'text/x-vcard', 'text/directory']);

/** Why a picked file is not read, or null when it is. */
export function vcardFileRejection(file: {
	name: string;
	size: number;
	type: string;
}): VcardFileRejection | null {
	const name = file.name.toLowerCase();
	const isVcard =
		VCARD_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
		VCARD_MIME_TYPES.has(file.type.toLowerCase());
	if (!isVcard) return 'wrong_type';
	if (file.size > VCARD_MAX_FILE_BYTES) return 'too_large';
	return null;
}

/** The export's file name, dated so a second export does not overwrite the first. */
export function vcardExportFilename(now: Date): string {
	return `owlat-contacts-${now.toISOString().slice(0, 10)}.vcf`;
}

/** The entry an address-book row exports as. */
export function vcardEntryOfContact(contact: VcardContactEntry): VcardContactEntry {
	return {
		email: contact.email,
		displayName: contact.displayName,
		organization: contact.organization,
		phones: contact.phones,
		postalAddresses: contact.postalAddresses,
	};
}
