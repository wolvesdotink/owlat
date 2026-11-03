/**
 * The file decisions of the Postbox address book's vCard import and export.
 * Pure, so they are testable without a DOM; the reading and writing is
 * `~/lib/postboxVcardTransfer`.
 */

import { VCARD_MAX_FILE_BYTES } from '@owlat/shared/postboxVcardLimits';

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
