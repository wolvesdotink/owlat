/**
 * Magic Bytes File Type Detection
 *
 * Detects file types by inspecting the first few bytes of a file (magic numbers).
 * This is more reliable than extension checking since users can rename files
 * to bypass extension-based filters.
 *
 * Only needs the first 16 bytes of a file to make a determination.
 */

interface MagicSignature {
	/** The byte pattern to match */
	bytes: number[];
	/** Offset from start of file to begin matching (default: 0) */
	offset?: number;
	/** Detected file type identifier */
	type: string;
	/** MIME type */
	mime: string;
	/** Whether this file type is considered dangerous */
	dangerous: boolean;
	/** Human-readable description */
	description: string;
}

/**
 * Known magic byte signatures.
 * Ordered by specificity — more specific patterns first.
 */
const MAGIC_SIGNATURES: MagicSignature[] = [
	// ---- DANGEROUS EXECUTABLES ----

	// Windows PE executable (.exe, .dll, .scr, .com)
	{
		bytes: [0x4d, 0x5a],
		type: 'exe',
		mime: 'application/x-msdownload',
		dangerous: true,
		description: 'Windows executable (PE)',
	},

	// OLE2 compound document — the container of BOTH `.msi` installers and
	// legacy Office documents (`.doc`/`.xls`/`.ppt`). Dangerous by default and
	// reconciled with the filename in `detectFileType`; see OLE2_DOCUMENT_MIMES.
	{
		bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
		type: 'msi',
		mime: 'application/x-msi',
		dangerous: true,
		description: 'Microsoft Installer / OLE2 compound document',
	},

	// ELF executable (Linux)
	{
		bytes: [0x7f, 0x45, 0x4c, 0x46],
		type: 'elf',
		mime: 'application/x-elf',
		dangerous: true,
		description: 'Linux executable (ELF)',
	},

	// Mach-O executable (macOS)
	{
		bytes: [0xfe, 0xed, 0xfa, 0xce],
		type: 'macho',
		mime: 'application/x-mach-binary',
		dangerous: true,
		description: 'macOS executable (Mach-O 32-bit)',
	},
	{
		bytes: [0xfe, 0xed, 0xfa, 0xcf],
		type: 'macho64',
		mime: 'application/x-mach-binary',
		dangerous: true,
		description: 'macOS executable (Mach-O 64-bit)',
	},
	{
		bytes: [0xcf, 0xfa, 0xed, 0xfe],
		type: 'macho64le',
		mime: 'application/x-mach-binary',
		dangerous: true,
		description: 'macOS executable (Mach-O 64-bit LE)',
	},
	{
		bytes: [0xca, 0xfe, 0xba, 0xbe],
		type: 'macho-universal',
		mime: 'application/x-mach-binary',
		dangerous: true,
		description: 'macOS universal binary',
	},

	// ISO disk image: the "CD001" descriptor lives at offset 0x8001, far past
	// the first-bytes window every caller passes, so it cannot be matched here.
	// It is checked separately in detectFileType via the optional `isoProbe`
	// (the 5 bytes at 0x8001), which callers slice cheaply from the full file.

	// ---- SAFE DOCUMENT FORMATS ----

	// PDF
	{
		bytes: [0x25, 0x50, 0x44, 0x46],
		type: 'pdf',
		mime: 'application/pdf',
		dangerous: false,
		description: 'PDF document',
	},

	// ZIP archive (also .docx, .xlsx, .pptx, .jar, .odt, .ods)
	// Note: ZIP-based formats need further extension checking to differentiate
	{
		bytes: [0x50, 0x4b, 0x03, 0x04],
		type: 'zip',
		mime: 'application/zip',
		dangerous: false,
		description: 'ZIP archive',
	},
	{
		bytes: [0x50, 0x4b, 0x05, 0x06],
		type: 'zip-empty',
		mime: 'application/zip',
		dangerous: false,
		description: 'ZIP archive (empty)',
	},

	// GZIP
	{
		bytes: [0x1f, 0x8b],
		type: 'gzip',
		mime: 'application/gzip',
		dangerous: false,
		description: 'GZIP archive',
	},

	// RAR archive
	{
		bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
		type: 'rar',
		mime: 'application/x-rar-compressed',
		dangerous: false,
		description: 'RAR archive',
	},

	// 7-Zip archive
	{
		bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
		type: '7z',
		mime: 'application/x-7z-compressed',
		dangerous: false,
		description: '7-Zip archive',
	},

	// ---- SAFE IMAGE FORMATS ----

	// PNG
	{
		bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		type: 'png',
		mime: 'image/png',
		dangerous: false,
		description: 'PNG image',
	},

	// JPEG
	{
		bytes: [0xff, 0xd8, 0xff],
		type: 'jpeg',
		mime: 'image/jpeg',
		dangerous: false,
		description: 'JPEG image',
	},

	// GIF
	{
		bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
		type: 'gif87',
		mime: 'image/gif',
		dangerous: false,
		description: 'GIF image (87a)',
	},
	{
		bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
		type: 'gif89',
		mime: 'image/gif',
		dangerous: false,
		description: 'GIF image (89a)',
	},

	// WebP
	{
		bytes: [0x52, 0x49, 0x46, 0x46],
		type: 'webp-riff',
		mime: 'image/webp',
		dangerous: false,
		description: 'WebP image (RIFF container)',
	},

	// BMP
	{
		bytes: [0x42, 0x4d],
		type: 'bmp',
		mime: 'image/bmp',
		dangerous: false,
		description: 'BMP image',
	},

	// TIFF
	{
		bytes: [0x49, 0x49, 0x2a, 0x00],
		type: 'tiff-le',
		mime: 'image/tiff',
		dangerous: false,
		description: 'TIFF image (little-endian)',
	},
	{
		bytes: [0x4d, 0x4d, 0x00, 0x2a],
		type: 'tiff-be',
		mime: 'image/tiff',
		dangerous: false,
		description: 'TIFF image (big-endian)',
	},

	// ICO
	{
		bytes: [0x00, 0x00, 0x01, 0x00],
		type: 'ico',
		mime: 'image/x-icon',
		dangerous: false,
		description: 'ICO icon',
	},

	// SVG is text-based (XML), cannot be detected by magic bytes alone
];

export interface MagicBytesResult {
	/** Detected file type identifier (e.g., 'exe', 'pdf', 'png') */
	type: string;
	/** MIME type */
	mime: string;
	/** Whether this file type is inherently dangerous */
	dangerous: boolean;
	/** Human-readable description */
	description: string;
}

/** ISO 9660 volume descriptor identifier ("CD001"), located at offset 0x8001. */
const ISO_9660_DESCRIPTOR = [0x43, 0x44, 0x30, 0x30, 0x31];

/**
 * The legacy Office formats that share the `.msi` installer's OLE2 magic, and
 * what they actually are.
 *
 * ONE magic number, two very different files: `D0 CF 11 E0 A1 B1 1A E1` opens a
 * Word 97 document exactly as it opens an installer, and the bytes cannot tell
 * them apart. Flagging the container as dangerous therefore refused every
 * `report.doc` and `q3.xls` a customer ever attached — types the policy
 * allowlist explicitly permits — and on the inbound path that refusal was read
 * as a malware finding. The extension is the only disambiguator there is, and
 * it is a safe one: a renamed installer still has to carry an extension, and
 * one that claims `.doc` is refused by the double-extension and allowlist
 * checks it still has to pass.
 */
const OLE2_DOCUMENT_MIMES: Record<string, { mime: string; description: string }> = {
	'.doc': { mime: 'application/msword', description: 'Word 97-2003 document' },
	'.dot': { mime: 'application/msword', description: 'Word 97-2003 template' },
	'.xls': { mime: 'application/vnd.ms-excel', description: 'Excel 97-2003 workbook' },
	'.ppt': { mime: 'application/vnd.ms-powerpoint', description: 'PowerPoint 97-2003 presentation' },
};

/** The OLE2 signature's `type`, as spelled in MAGIC_SIGNATURES. */
const OLE2_TYPE = 'msi';

/** The legacy-Office reading of an OLE2 container, when the name claims one. */
function ole2DocumentFor(filename: string | undefined): MagicBytesResult | null {
	if (!filename) return null;
	const lastDot = filename.lastIndexOf('.');
	if (lastDot === -1) return null;
	const known = OLE2_DOCUMENT_MIMES[filename.substring(lastDot).toLowerCase()];
	if (!known) return null;
	return {
		type: 'ole2-document',
		mime: known.mime,
		dangerous: false,
		description: known.description,
	};
}

function matchesAt(bytes: Uint8Array, offset: number, pattern: number[]): boolean {
	if (bytes.length < offset + pattern.length) return false;
	for (let i = 0; i < pattern.length; i++) {
		if (bytes[offset + i] !== pattern[i]) return false;
	}
	return true;
}

/**
 * Detect file type from magic bytes (first bytes of a file).
 *
 * @param firstBytes - The first 16+ bytes of the file
 * @param isoProbe - Optional bytes at offset 0x8001 (the ISO 9660 descriptor
 *   location). Pass `file.subarray(0x8001, 0x8006)` to enable ISO detection;
 *   the ISO marker is too deep to live in `firstBytes`.
 * @param filename - Optional filename, used ONLY to disambiguate the one
 *   signature that is genuinely ambiguous: the OLE2 container shared by `.msi`
 *   installers and legacy Office documents. Omit it and OLE2 stays dangerous.
 * @returns Detection result, or null if no known signature matches
 */
export function detectFileType(
	firstBytes: Uint8Array,
	isoProbe?: Uint8Array,
	filename?: string
): MagicBytesResult | null {
	for (const sig of MAGIC_SIGNATURES) {
		if (matchesAt(firstBytes, sig.offset ?? 0, sig.bytes)) {
			if (sig.type === OLE2_TYPE) {
				const document = ole2DocumentFor(filename);
				if (document) return document;
			}
			return {
				type: sig.type,
				mime: sig.mime,
				dangerous: sig.dangerous,
				description: sig.description,
			};
		}
	}

	// ISO disk image — checked via the deep probe when the caller supplies it.
	if (isoProbe && matchesAt(isoProbe, 0, ISO_9660_DESCRIPTOR)) {
		return {
			type: 'iso',
			mime: 'application/x-iso9660-image',
			dangerous: true,
			description: 'ISO disk image',
		};
	}

	return null;
}

/**
 * Check if file bytes indicate a dangerous executable type.
 *
 * Quick boolean check for use in validation pipelines. Pass `isoProbe` (the
 * bytes at offset 0x8001) to also flag renamed ISO disk images.
 */
export function isDangerousFileType(
	firstBytes: Uint8Array,
	isoProbe?: Uint8Array,
	filename?: string
): boolean {
	const result = detectFileType(firstBytes, isoProbe, filename);
	return result?.dangerous ?? false;
}
