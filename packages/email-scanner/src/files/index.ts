/**
 * File Validation — Main Orchestrator
 *
 * Combines magic bytes detection, double extension checking, and
 * file policy enforcement into a single validation function.
 */

import type { ContentFlag, FilePolicy, FileValidationResult } from '../types.js';
import { detectFileType } from './magicBytes.js';
import { detectDoubleExtension, isExecutableExtension } from './doubleExtension.js';
import { DEFAULT_FILE_POLICY, isExtensionAllowed, isFileSizeAllowed } from './filePolicy.js';

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
	isoProbe?: Uint8Array,
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

	// Check 2: Magic bytes detection (if bytes provided)
	if (firstBytes && firstBytes.length >= 2) {
		const magicResult = detectFileType(firstBytes, isoProbe);

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
			const mimeAllowed = policy.allowedTypes.some(allowed =>
				magicResult.mime === allowed || magicResult.mime.startsWith(allowed)
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
	const magicResult = firstBytes ? detectFileType(firstBytes, isoProbe) : null;
	return {
		allowed: true,
		detectedType: magicResult?.mime ?? 'unknown',
		dangerousType: false,
		doubleExtension: false,
	};
}

/**
 * Generate content flags from file validation results.
 * Useful for integrating file validation into the content scanning pipeline.
 */
export function fileValidationToFlags(
	filename: string,
	result: FileValidationResult,
): ContentFlag[] {
	if (result.allowed) return [];

	const flags: ContentFlag[] = [];

	if (result.dangerousType || result.doubleExtension) {
		flags.push({
			type: 'dangerous_file_type',
			severity: 'high',
			description: result.reason ?? `Dangerous file detected: ${filename}`,
			match: filename,
		});
	} else {
		flags.push({
			type: 'dangerous_file_type',
			severity: 'medium',
			description: result.reason ?? `Disallowed file type: ${filename}`,
			match: filename,
		});
	}

	return flags;
}

// Re-export sub-modules
export { detectFileType, isDangerousFileType } from './magicBytes.js';
export { detectDoubleExtension, isExecutableExtension } from './doubleExtension.js';
export { DEFAULT_FILE_POLICY, isMimeTypeAllowed, isExtensionAllowed, isFileSizeAllowed, mergePolicy } from './filePolicy.js';
