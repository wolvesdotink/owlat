import { describe, it, expect } from 'vitest';
import { detectFileType, isDangerousFileType } from '../files/magicBytes.js';

describe('magic bytes detection', () => {
	describe('detectFileType', () => {
		it('detects Windows PE executable (.exe)', () => {
			const bytes = new Uint8Array([0x4D, 0x5A, 0x90, 0x00]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('exe');
			expect(result!.dangerous).toBe(true);
			expect(result!.mime).toBe('application/x-msdownload');
		});

		it('detects ELF executable (Linux)', () => {
			const bytes = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('elf');
			expect(result!.dangerous).toBe(true);
		});

		it('detects Mach-O executable (macOS 64-bit)', () => {
			const bytes = new Uint8Array([0xFE, 0xED, 0xFA, 0xCF]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.dangerous).toBe(true);
		});

		it('detects PDF document', () => {
			const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('pdf');
			expect(result!.dangerous).toBe(false);
			expect(result!.mime).toBe('application/pdf');
		});

		it('detects PNG image', () => {
			const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('png');
			expect(result!.dangerous).toBe(false);
			expect(result!.mime).toBe('image/png');
		});

		it('detects JPEG image', () => {
			const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('jpeg');
			expect(result!.dangerous).toBe(false);
		});

		it('detects GIF image (89a)', () => {
			const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('gif89');
			expect(result!.dangerous).toBe(false);
		});

		it('detects ZIP archive', () => {
			const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('zip');
			expect(result!.dangerous).toBe(false);
		});

		it('detects GZIP archive', () => {
			const bytes = new Uint8Array([0x1F, 0x8B, 0x08]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('gzip');
			expect(result!.dangerous).toBe(false);
		});

		it('detects MSI installer / OLE2 compound document', () => {
			const bytes = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('msi');
			expect(result!.dangerous).toBe(true);
		});

		it('detects RAR archive', () => {
			const bytes = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('rar');
			expect(result!.dangerous).toBe(false);
		});

		it('detects BMP image', () => {
			// Note: BMP starts with 'BM' (0x42, 0x4D) which is same pattern as exe check
			// But exe is 'MZ' (0x4D, 0x5A), so they don't conflict
			const bytes = new Uint8Array([0x42, 0x4D, 0x36, 0x00]);
			const result = detectFileType(bytes);

			expect(result).not.toBeNull();
			expect(result!.type).toBe('bmp');
			expect(result!.dangerous).toBe(false);
		});

		it('returns null for unknown file types', () => {
			const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
			const result = detectFileType(bytes);

			expect(result).toBeNull();
		});

		it('returns null for empty input', () => {
			const bytes = new Uint8Array([]);
			const result = detectFileType(bytes);

			expect(result).toBeNull();
		});

		it('returns null for single byte', () => {
			const bytes = new Uint8Array([0x4D]);
			const result = detectFileType(bytes);

			// MZ needs 2 bytes
			expect(result).toBeNull();
		});

		it('detects a (renamed) ISO disk image via the deep probe', () => {
			// An ISO's first bytes are arbitrary (system area); the "CD001"
			// descriptor lives at offset 0x8001 and is supplied as isoProbe.
			const firstBytes = new Uint8Array(32); // zero-filled, no leading signature
			const isoProbe = new Uint8Array([0x43, 0x44, 0x30, 0x30, 0x31]); // "CD001"
			const result = detectFileType(firstBytes, isoProbe);

			expect(result?.type).toBe('iso');
			expect(result?.dangerous).toBe(true);
		});

		it('does not flag ISO without the probe (offset too deep for firstBytes)', () => {
			expect(detectFileType(new Uint8Array(32))).toBeNull();
		});
	});

	describe('isDangerousFileType', () => {
		it('returns true for exe', () => {
			expect(isDangerousFileType(new Uint8Array([0x4D, 0x5A, 0x90]))).toBe(true);
		});

		it('returns true for a renamed ISO when the deep probe is supplied', () => {
			expect(
				isDangerousFileType(new Uint8Array(32), new Uint8Array([0x43, 0x44, 0x30, 0x30, 0x31])),
			).toBe(true);
		});

		it('returns false for PNG', () => {
			expect(isDangerousFileType(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBe(false);
		});

		it('returns false for unknown types', () => {
			expect(isDangerousFileType(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
		});
	});
});

// filePolicy default-policy security expectations (see filePolicy.ts)
import { DEFAULT_FILE_POLICY, isMimeTypeAllowed, isExtensionAllowed, mergePolicy } from '../files/filePolicy.js';

describe('DEFAULT_FILE_POLICY', () => {
	it('rejects script-capable SVG by default', () => {
		expect(isMimeTypeAllowed('image/svg+xml')).toBe(false);
		expect(isExtensionAllowed('logo.svg')).toBe(false);
	});

	it('still allows SVG via an explicit policy override', () => {
		const policy = mergePolicy({
			allowedTypes: [...DEFAULT_FILE_POLICY.allowedTypes, 'image/svg+xml'],
			allowedExtensions: [...DEFAULT_FILE_POLICY.allowedExtensions, '.svg'],
		});
		expect(isMimeTypeAllowed('image/svg+xml', policy)).toBe(true);
		expect(isExtensionAllowed('logo.svg', policy)).toBe(true);
	});

	it('matches MIME parameters but not unrelated shared-prefix types', () => {
		expect(isMimeTypeAllowed('text/plain; charset=utf-8')).toBe(true);
		expect(isMimeTypeAllowed('application/jsonx')).toBe(false);
	});
});
