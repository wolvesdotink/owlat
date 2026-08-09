import { imageSize } from 'image-size';
import { describe, expect, it } from 'vitest';

function writeAscii(buffer: Uint8Array, offset: number, value: string): void {
	buffer.set(Buffer.from(value, 'ascii'), offset);
}

function writeUInt32BE(buffer: Uint8Array, offset: number, value: number): void {
	new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(offset, value, false);
}

function maliciousIcns(): Uint8Array {
	const buffer = new Uint8Array(16);
	writeAscii(buffer, 0, 'icns');
	writeUInt32BE(buffer, 4, buffer.length);
	writeAscii(buffer, 8, 'ic07');
	writeUInt32BE(buffer, 12, 0);
	return buffer;
}

function maliciousHeif(): Uint8Array {
	const buffer = new Uint8Array(60);
	writeUInt32BE(buffer, 0, 12);
	writeAscii(buffer, 4, 'ftyp');
	writeAscii(buffer, 8, 'heic');
	writeUInt32BE(buffer, 12, 48);
	writeAscii(buffer, 16, 'meta');
	writeUInt32BE(buffer, 24, 36);
	writeAscii(buffer, 28, 'iprp');
	writeUInt32BE(buffer, 32, 28);
	writeAscii(buffer, 36, 'ipco');
	writeUInt32BE(buffer, 40, 0);
	writeAscii(buffer, 44, 'ispe');
	return buffer;
}

function maliciousJxl(): Uint8Array {
	const buffer = new Uint8Array(36);
	writeUInt32BE(buffer, 0, 12);
	writeAscii(buffer, 4, 'JXL ');
	writeUInt32BE(buffer, 12, 12);
	writeAscii(buffer, 16, 'ftyp');
	writeAscii(buffer, 20, 'jxl ');
	writeUInt32BE(buffer, 24, 0);
	writeAscii(buffer, 28, 'jxlp');
	return buffer;
}

describe('patched image-size parser termination', () => {
	it.each([
		['ICNS', maliciousIcns],
		['HEIF', maliciousHeif],
		['JXL', maliciousJxl],
	])('rejects a non-advancing %s payload', (_format, payload) => {
		expect(() => imageSize(payload())).toThrow();
	});
});
