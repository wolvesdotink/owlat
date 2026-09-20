/**
 * File Validation — Main Orchestrator
 *
 * Combines magic bytes detection, double extension checking, and
 * file policy enforcement into a single validation function.
 */

import type { FilePolicy, FileValidationResult } from '../types.js';
import { detectFileType } from './magicBytes.js';
import { detectDoubleExtension, isExecutableExtension } from './doubleExtension.js';
import {
	DEFAULT_FILE_POLICY,
	isExtensionAllowed,
	isFileSizeAllowed,
	isMimeTypeAllowed,
} from './filePolicy.js';

/**
 * The WHOLE type verdict for one file: the double-extension trick, the
 * executable check, the extension allowlist and the MIME allowlist, in one
 * call.
 *
 * Its callers are `semanticFiles.ingest` and the inbound `captureAttachments`
 * pre-filter, which is how the attachment-capture path came to charge an AI
 * budget for parts a later gate was always going to reject: one predicate means
 * the decision can be made BEFORE the cost is incurred, by a caller that is not
 * the one storing the file. The upload mutations (`semanticFiles.create`,
 * `mediaAssets.create`) keep the conjunction spelled out, because each reason
 * raises its own message at the user — this one answers yes or no.
 *
 * Distinct from {@link validateFile}, which inspects BYTES (magic numbers, the
 * ISO probe) and reports a reason. This one answers the name-and-type question
 * alone, which is all a caller deciding whether to spend anything needs.
 *
 * Size is deliberately not part of it — `isFileSizeAllowed` answers a different
 * question with a different remedy, and the callers report the two separately.
 */
export function isFileTypeAccepted(
	filename: string,
	mimeType: string,
	policy: FilePolicy = DEFAULT_FILE_POLICY
): boolean {
	const doubleExt = detectDoubleExtension(filename);
	if (doubleExt.detected && doubleExt.executableExtension) return false;
	if (isExecutableExtension(filename)) return false;
	if (!isExtensionAllowed(filename, policy)) return false;
	return isMimeTypeAllowed(mimeType, policy);
}

/**
 * Validate a file attachment for security.
 *
 * Performs three layers of checks:
 * 1. Double extension detection (e.g., "invoice.pdf.exe")
 * 2. Magic bytes detection (actual file type from binary header)
 * 3. Extension-based policy enforcement (allowlist)
 *
 * @param filename - The filename of the attachment
 * @param firstBytes - The first 16+ bytes of the file (for magic bytes detection)
 * @param policy - Optional custom file policy (defaults to DEFAULT_FILE_POLICY)
 * @param fileSize - Optional file size for size limit checking
 * @param isoProbe - Optional bytes at offset 0x8001 (slice from the full file)
 *   so a renamed ISO disk image is detected by its deep magic marker
 * @returns Validation result indicating whether the file is allowed
 */
export function validateFile(
	filename: string,
	firstBytes?: Uint8Array,
	policy: FilePolicy = DEFAULT_FILE_POLICY,
	fileSize?: number,
	isoProbe?: Uint8Array
): FileValidationResult {
	// Check 1: Double extension detection
	const doubleExt = detectDoubleExtension(filename);
	if (doubleExt.detected && doubleExt.executableExtension) {
		return {
			allowed: false,
			detectedType: doubleExt.hiddenExtension ?? 'unknown',
			reason: doubleExt.description ?? `Double extension detected: ${filename}`,
			dangerousType: true,
			doubleExtension: true,
		};
	}

	// Check 2: Magic bytes detection (if bytes provided). The filename goes in
	// because one signature is genuinely ambiguous — the OLE2 container is both
	// an installer and a Word 97 document — and only the name tells them apart.
	if (firstBytes && firstBytes.length >= 2) {
		const magicResult = detectFileType(firstBytes, isoProbe, filename);

		if (magicResult?.dangerous) {
			return {
				allowed: false,
				detectedType: magicResult.mime,
				reason: `Dangerous file type detected: ${magicResult.description} (${magicResult.mime})`,
				dangerousType: true,
				doubleExtension: false,
			};
		}

		// If magic bytes identify a safe type, use that as the detected type
		if (magicResult) {
			// Check if the detected MIME type is allowed by policy
			const mimeAllowed = policy.allowedTypes.some(
				(allowed) => magicResult.mime === allowed || magicResult.mime.startsWith(allowed)
			);

			if (!mimeAllowed) {
				return {
					allowed: false,
					detectedType: magicResult.mime,
					reason: `File type "${magicResult.description}" (${magicResult.mime}) is not in the allowed list`,
					dangerousType: false,
					doubleExtension: false,
				};
			}
		}
	}

	// Check 3: Extension-based policy
	if (isExecutableExtension(filename)) {
		return {
			allowed: false,
			detectedType: 'executable',
			reason: `Executable file extension detected: ${filename}`,
			dangerousType: true,
			doubleExtension: false,
		};
	}

	if (!isExtensionAllowed(filename, policy)) {
		const lastDot = filename.lastIndexOf('.');
		const ext = lastDot !== -1 ? filename.substring(lastDot) : 'none';
		return {
			allowed: false,
			detectedType: ext,
			reason: `File extension "${ext}" is not in the allowed list`,
			dangerousType: false,
			doubleExtension: false,
		};
	}

	// Check 4: File size
	if (fileSize !== undefined && !isFileSizeAllowed(fileSize, policy)) {
		const maxMB = policy.maxFileSize ? Math.round(policy.maxFileSize / 1024 / 1024) : 'unknown';
		return {
			allowed: false,
			detectedType: 'oversized',
			reason: `File size (${Math.round(fileSize / 1024 / 1024)}MB) exceeds maximum allowed size (${maxMB}MB)`,
			dangerousType: false,
			doubleExtension: false,
		};
	}

	// All checks passed
	const magicResult = firstBytes ? detectFileType(firstBytes, isoProbe, filename) : null;
	return {
		allowed: true,
		detectedType: magicResult?.mime ?? 'unknown',
		dangerousType: false,
		doubleExtension: false,
	};
}

// Re-export sub-modules
export { detectFileType, isDangerousFileType } from './magicBytes.js';
export { detectDoubleExtension, isExecutableExtension } from './doubleExtension.js';
export {
	DEFAULT_FILE_POLICY,
	isMimeTypeAllowed,
	isExtensionAllowed,
	isFileSizeAllowed,
	mergePolicy,
} from './filePolicy.js';
