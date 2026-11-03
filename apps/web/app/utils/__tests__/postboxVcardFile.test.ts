import { describe, expect, it } from 'vitest';
import { VCARD_MAX_FILE_BYTES } from '@owlat/shared/postboxVcard';
import { vcardExportFilename, vcardFileRejection } from '../postboxVcardFile';

describe('vcardFileRejection', () => {
	it('reads a .vcf or .vcard file, or a vCard MIME type, up to the size cap', () => {
		expect(vcardFileRejection({ name: 'Contacts.VCF', size: 10, type: '' })).toBeNull();
		expect(vcardFileRejection({ name: 'export.vcard', size: 10, type: '' })).toBeNull();
		expect(vcardFileRejection({ name: 'download', size: 10, type: 'text/x-vcard' })).toBeNull();
		expect(
			vcardFileRejection({ name: 'big.vcf', size: VCARD_MAX_FILE_BYTES, type: 'text/vcard' })
		).toBeNull();
	});

	it('refuses another file type before its size', () => {
		expect(vcardFileRejection({ name: 'audience.csv', size: 10, type: 'text/csv' })).toBe(
			'wrong_type'
		);
		expect(
			vcardFileRejection({ name: 'huge.csv', size: VCARD_MAX_FILE_BYTES + 1, type: 'text/csv' })
		).toBe('wrong_type');
		expect(vcardFileRejection({ name: 'huge.vcf', size: VCARD_MAX_FILE_BYTES + 1, type: '' })).toBe(
			'too_large'
		);
	});
});

describe('vcardExportFilename', () => {
	it('dates the file', () => {
		expect(vcardExportFilename(new Date('2026-11-03T05:00:00Z'))).toBe(
			'owlat-contacts-2026-11-03.vcf'
		);
	});
});
