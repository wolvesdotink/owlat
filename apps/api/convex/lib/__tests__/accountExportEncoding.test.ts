import { describe, expect, it } from 'vitest';
import { accountExportBytesToBase64 } from '../accountExportEncoding';

describe('accountExportBytesToBase64', () => {
	it('losslessly encodes byte arrays larger than one conversion chunk', () => {
		const bytes = Uint8Array.from({ length: 0x8000 + 257 }, (_, index) => index % 256);

		const encoded = accountExportBytesToBase64(bytes);

		expect(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))).toEqual(bytes);
	});
});
