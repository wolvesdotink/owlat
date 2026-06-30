/**
 * Double Extension Detection
 *
 * Detects files with hidden executable extensions like "invoice.pdf.exe"
 * or "report.docx.js" which are a common social engineering technique.
 */

/** Extensions that indicate executable/script content */
const EXECUTABLE_EXTENSIONS = new Set([
	'.exe', '.dll', '.scr', '.com', '.pif', '.bat', '.cmd',
	'.ps1', '.psm1', '.psd1', // PowerShell
	'.vbs', '.vbe', '.wsf', '.wsh', '.ws', // VBScript/Windows Script
	'.js', '.jse', '.mjs', // JavaScript (dangerous as email attachment)
	'.hta', '.htc',
	'.msi', '.msp', '.mst',
	'.cpl', '.inf', '.reg',
	'.jar', '.class', // Java
	'.py', '.pyc', '.pyw', // Python
	'.rb', '.sh', '.bash', '.csh', // Shell scripts
	'.app', '.action', '.command', // macOS
	'.iso', '.img', '.dmg', // Disk images (can contain executables)
	'.lnk', '.url', // Shortcuts (can point to malicious targets)
]);

/** Extensions that represent common document/media types (non-executable) */
const DOCUMENT_EXTENSIONS = new Set([
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	'.odt', '.ods', '.odp', '.rtf', '.txt', '.csv',
	'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.tiff',
	'.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
	'.zip', '.tar', '.gz', '.rar', '.7z',
	'.html', '.htm', '.xml', '.json', '.yaml', '.yml',
]);

export interface DoubleExtensionResult {
	/** Whether a double extension was detected */
	detected: boolean;
	/** The visible (outer) extension */
	visibleExtension?: string;
	/** The hidden (inner) extension that a user might see */
	hiddenExtension?: string;
	/** Whether the actual extension is executable */
	executableExtension?: boolean;
	/** Human-readable description */
	description?: string;
}

/**
 * Extract all extensions from a filename.
 * e.g., "invoice.pdf.exe" → ['.pdf', '.exe']
 */
function extractExtensions(filename: string): string[] {
	const parts = filename.split('.');
	if (parts.length <= 1) return [];

	// First part is the name, rest are extensions
	return parts.slice(1).map(ext => `.${ext.toLowerCase()}`);
}

/**
 * Check a filename for suspicious double extensions.
 *
 * A double extension is suspicious when:
 * 1. There are 2+ extensions
 * 2. The final extension is executable
 * 3. An earlier extension is a document type (making it look safe)
 *
 * Examples:
 * - "invoice.pdf.exe" → detected (pdf looks safe, exe is dangerous)
 * - "archive.tar.gz" → not detected (both are archive-related)
 * - "photo.jpg.scr" → detected (jpg looks safe, scr is dangerous)
 */
export function detectDoubleExtension(filename: string): DoubleExtensionResult {
	const extensions = extractExtensions(filename);

	if (extensions.length < 2) {
		return { detected: false };
	}

	const finalExt = extensions[extensions.length - 1]!;
	const isExecutable = EXECUTABLE_EXTENSIONS.has(finalExt);

	if (!isExecutable) {
		return { detected: false };
	}

	// Check if any earlier extension is a document/media type
	for (let i = 0; i < extensions.length - 1; i++) {
		const ext = extensions[i]!;
		if (DOCUMENT_EXTENSIONS.has(ext)) {
			return {
				detected: true,
				visibleExtension: ext,
				hiddenExtension: finalExt,
				executableExtension: true,
				description: `File "${filename}" has a hidden executable extension "${finalExt}" after "${ext}" — likely malicious`,
			};
		}
	}

	// Even without a document extension, flag executable + any other extension
	const innerExt = extensions[extensions.length - 2]!;
	return {
		detected: true,
		visibleExtension: innerExt,
		hiddenExtension: finalExt,
		executableExtension: true,
		description: `File "${filename}" has multiple extensions ending with executable "${finalExt}"`,
	};
}

/**
 * Check if a file extension is in the executable set.
 */
export function isExecutableExtension(filename: string): boolean {
	const lastDot = filename.lastIndexOf('.');
	if (lastDot === -1) return false;
	const ext = filename.substring(lastDot).toLowerCase();
	return EXECUTABLE_EXTENSIONS.has(ext);
}
