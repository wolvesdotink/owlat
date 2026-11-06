/**
 * vCard import and export for the Postbox address book (`mailContacts`).
 *
 * Reads vCard 3.0 (RFC 2426) and 4.0 (RFC 6350), and the quoted-printable
 * lines phones still write in 2.1. Writes 3.0, the version every address book
 * imports. The address book is keyed by email address, so one card becomes one
 * entry per address on it, and a card without an address is skipped.
 *
 * A .vcf file is untrusted input. Every bound in `postboxVcardEntry.ts` holds
 * in the parser, and {@link normalizeVcardImportEntry} applies the per-entry
 * bounds again on the server, which never trusts the browser that parsed the
 * file. Only the properties the parser reads are assembled from their folded
 * lines; notes and every other property are skipped as they stream past. An
 * inline PHOTO is assembled only up to `VCARD_MAX_PHOTO_BYTES`, and a
 * larger one is skipped the same way, so a file of large embedded pictures
 * costs a line scan and no more. A picture named by a URL is never fetched.
 */

import { VCARD_ADDRESS_PARTS, type VcardContactEntry } from './postboxVcardEntry';

export * from './postboxVcardEntry';
export * from './postboxVcardLimits';
export { parseVcards, type VcardParseResult } from './postboxVcardParse';

function escapeText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/\r\n|\n|\r/g, '\\n')
		.replace(/,/g, '\\,')
		.replace(/;/g, '\\;');
}

function utf8Length(codePoint: number): number {
	return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Fold a content line at 75 octets without splitting a character. */
function foldLine(line: string): string {
	const out: string[] = [];
	let current = '';
	let octets = 0;
	for (const char of line) {
		const size = utf8Length(char.codePointAt(0)!);
		if (octets + size > 75) {
			out.push(current);
			current = ' ';
			octets = 1;
		}
		current += char;
		octets += size;
	}
	out.push(current);
	return out.join('\r\n');
}

/** A vCard 3.0 file holding one card per entry, CRLF line endings. */
export function serializeVcards(entries: readonly VcardContactEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		const name = entry.displayName?.trim() || entry.email;
		lines.push('BEGIN:VCARD', 'VERSION:3.0');
		lines.push(`FN:${escapeText(name)}`);
		lines.push(`N:;${escapeText(entry.displayName?.trim() ?? '')};;;`);
		if (entry.organization) lines.push(`ORG:${escapeText(entry.organization)}`);
		lines.push(`EMAIL;TYPE=INTERNET:${escapeText(entry.email)}`);
		for (const phone of entry.phones ?? []) {
			const type = phone.type ? `;TYPE=${phone.type.toUpperCase()}` : '';
			lines.push(`TEL${type}:${escapeText(phone.value)}`);
		}
		for (const address of entry.postalAddresses ?? []) {
			const type = address.type ? `;TYPE=${address.type.toUpperCase()}` : '';
			const parts = VCARD_ADDRESS_PARTS.map((part) => escapeText(address[part] ?? ''));
			lines.push(`ADR${type}:${parts.join(';')}`);
		}
		if (entry.photo) {
			const type = entry.photo.mediaType.slice('image/'.length).toUpperCase();
			lines.push(`PHOTO;ENCODING=b;TYPE=${type}:${entry.photo.base64}`);
		}
		lines.push('END:VCARD');
	}
	return lines.length > 0 ? `${lines.map(foldLine).join('\r\n')}\r\n` : '';
}
