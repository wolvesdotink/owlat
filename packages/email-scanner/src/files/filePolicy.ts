/**
 * File Policy Engine
 *
 * Defines and enforces allowlist/blocklist policies for file attachments.
 * Uses an allowlist approach: only explicitly permitted file types are allowed.
 */

import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import type { FilePolicy } from '../types.js';

/**
 * Default file policy — permissive enough for legitimate email attachments,
 * restrictive enough to block executables and scripts.
 */
export const DEFAULT_FILE_POLICY: FilePolicy = {
	allowedTypes: [
		// Images
		'image/jpeg',
		'image/png',
		'image/gif',
		'image/webp',
		'image/bmp',
		'image/tiff',
		// image/svg+xml deliberately ABSENT: SVG is script-capable (inline
		// <script>, event handlers, foreignObject) and executes when a recipient
		// opens the attachment directly. Opt back in per call-site via
		// mergePolicy if the surface only ever renders it as <img>.
		'image/x-icon',

		// Documents
		'application/pdf',
		'application/msword',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.oasis.opendocument.text',
		'text/plain',
		'text/csv',
		'text/html',
		'application/rtf',

		// Spreadsheets
		'application/vnd.ms-excel',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'application/vnd.oasis.opendocument.spreadsheet',

		// Presentations
		'application/vnd.ms-powerpoint',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'application/vnd.oasis.opendocument.presentation',

		// Archives (may contain executables — consider scanning contents)
		'application/zip',
		'application/gzip',
		'application/x-tar',

		// Audio/Video
		'audio/mpeg',
		'audio/wav',
		'audio/ogg',
		'video/mp4',
		'video/webm',

		// Fonts (for email rendering)
		'font/woff',
		'font/woff2',
		'font/ttf',
		'font/otf',

		// Data
		'application/json',
		'application/xml',
		'text/xml',
	],

	allowedExtensions: [
		// Images
		'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico',

		// Documents
		'.pdf', '.doc', '.docx', '.odt', '.txt', '.csv', '.rtf', '.html', '.htm',

		// Spreadsheets
		'.xls', '.xlsx', '.ods',

		// Presentations
		'.ppt', '.pptx', '.odp',

		// Archives
		'.zip', '.gz', '.tar', '.tgz',

		// Audio/Video
		'.mp3', '.wav', '.ogg', '.mp4', '.webm',

		// Data
		'.json', '.xml', '.yaml', '.yml',

		// Fonts
		'.woff', '.woff2', '.ttf', '.otf',

		// Calendar
		'.ics', '.ical',

		// vCard
		'.vcf',
	],

	maxFileSize: MAX_ATTACHMENT_BYTES,
};

/**
 * Check if a MIME type is allowed by the policy.
 */
export function isMimeTypeAllowed(mimeType: string, policy: FilePolicy = DEFAULT_FILE_POLICY): boolean {
	const normalized = mimeType.toLowerCase().trim();
	// Exact match, or the allowed type followed by parameters ("text/plain;
	// charset=utf-8"). A bare startsWith would also pass unrelated types that
	// merely share a prefix (application/json vs application/jsonx).
	return policy.allowedTypes.some(allowed =>
		normalized === allowed || normalized.startsWith(`${allowed};`)
	);
}

/**
 * Check if a file extension is allowed by the policy.
 */
export function isExtensionAllowed(filename: string, policy: FilePolicy = DEFAULT_FILE_POLICY): boolean {
	const lastDot = filename.lastIndexOf('.');
	if (lastDot === -1) return false; // No extension → block by default

	const ext = filename.substring(lastDot).toLowerCase();
	return policy.allowedExtensions.includes(ext);
}

/**
 * Check if a file size is within the policy limit.
 */
export function isFileSizeAllowed(size: number, policy: FilePolicy = DEFAULT_FILE_POLICY): boolean {
	if (!policy.maxFileSize) return true;
	return size <= policy.maxFileSize;
}

/**
 * Merge a custom policy with the defaults.
 * Custom policy values override defaults where provided.
 */
export function mergePolicy(custom: Partial<FilePolicy>): FilePolicy {
	return {
		allowedTypes: custom.allowedTypes ?? DEFAULT_FILE_POLICY.allowedTypes,
		allowedExtensions: custom.allowedExtensions ?? DEFAULT_FILE_POLICY.allowedExtensions,
		maxFileSize: custom.maxFileSize ?? DEFAULT_FILE_POLICY.maxFileSize,
	};
}
