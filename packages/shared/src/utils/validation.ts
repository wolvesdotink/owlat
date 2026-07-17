/**
 * Shared validation utilities and regex patterns
 * These core validators can be used across frontend and backend
 */

// ============================================================================
// Regex Patterns
// ============================================================================

/**
 * Email validation regex.
 *
 * Rejects: consecutive dots, leading/trailing dots in local/domain,
 * leading/trailing hyphens in domain labels, and requires a 2+ char TLD.
 *
 * Accepts internationalized (RFC 6531/6532 SMTPUTF8 / EAI) addresses: the
 * local-part, domain labels and TLD admit any non-ASCII code point in the
 * `\u{80}`–`\u{10FFFF}` range EXCEPT the Unicode `\p{C}` (control / format /
 * surrogate / unassigned / private-use) and `\p{Z}` (space / separator) classes —
 * subtracted via the `v` (unicodeSets) flag. That keeps a real UTF-8 mailbox such
 * as `用户@例え.test` or `Pelé@exämple.test` valid while rejecting the Unicode
 * equivalents of the pinned ASCII-space rejection: U+00A0 (NBSP), U+200B (ZWSP),
 * U+2028/U+2029 (line/paragraph separators), U+0085 (NEL), the BiDi overrides
 * U+202A–U+202E, and lone surrogates — code points that would spoof or mangle an
 * imported address. ASCII structure (dot/hyphen placement, TLD length) is
 * unchanged, so every previously-valid address stays valid and every
 * previously-invalid ASCII address stays invalid.
 */
export const emailRegex =
	/^[[a-zA-Z0-9!#$%&'*+\/=?^_`\{\|\}~\u{80}-\u{10FFFF}\-]--[\p{C}\p{Z}]]+(?:\.[[a-zA-Z0-9!#$%&'*+\/=?^_`\{\|\}~\u{80}-\u{10FFFF}\-]--[\p{C}\p{Z}]]+)*@(?:[[a-zA-Z0-9\u{80}-\u{10FFFF}]--[\p{C}\p{Z}]](?:[[a-zA-Z0-9\u{80}-\u{10FFFF}\-]--[\p{C}\p{Z}]]*[[a-zA-Z0-9\u{80}-\u{10FFFF}]--[\p{C}\p{Z}]])?\.)+[[a-zA-Z\u{80}-\u{10FFFF}]--[\p{C}\p{Z}]]{2,}$/v;

/**
 * Domain validation regex
 * Matches valid domain names (e.g., example.com, mail.example.co.uk)
 */
export const domainRegex = /^(?!-)[A-Za-z0-9-]+([-.][A-Za-z0-9]+)*\.[A-Za-z]{2,}$/;

/**
 * URL validation regex
 * Matches http and https URLs
 */
export const urlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/**
 * Phone number validation regex (international format)
 * Matches various phone formats
 */
export const phoneRegex = /^\+?[1-9]\d{1,14}$/;

/**
 * Slug validation regex
 * Matches URL-safe slugs (lowercase letters, numbers, hyphens)
 */
export const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate an email address
 */
export function isValidEmail(email: string): boolean {
	return emailRegex.test(email);
}

/**
 * Validate a domain name
 */
export function isValidDomain(domain: string): boolean {
	return domainRegex.test(domain);
}

/**
 * Validate a URL using the URL constructor
 */
export function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate a phone number (international format)
 * Strips common formatting characters before validation
 */
export function isValidPhone(phone: string): boolean {
	return phoneRegex.test(phone.replace(/[\s()-]/g, ''));
}

/**
 * Validate a slug
 */
export function isValidSlug(slug: string): boolean {
	return slugRegex.test(slug);
}

/**
 * Check if a string is empty or only whitespace
 */
export function isEmpty(value: string | null | undefined): boolean {
	return value === null || value === undefined || value.trim() === '';
}

/**
 * Check if a value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/**
 * Sanitize a string for use as a slug
 */
export function toSlug(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
