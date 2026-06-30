import { isValidEmail as sharedIsValidEmail, normalizeEmail } from '@owlat/shared';

/**
 * `decodeURIComponent` that returns `null` instead of throwing on malformed
 * percent-encoding (e.g. a stray `%` in a path segment). Lets HTTP handlers map
 * a bad path segment to a 400 invalid_input rather than a generic 500.
 */
export function safeDecodeURIComponent(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

/**
 * Fold an email into its canonical lookup key (trimmed + lowercased).
 * Re-exported from `@owlat/shared` so the Convex backend imports email
 * primitives from one local module.
 */
export { normalizeEmail };

/**
 * Validate an email address format.
 *
 * Delegates to the shared RFC-compliant validator and adds an RFC 5321
 * length cap (254 chars). This is the single source of truth for email
 * validation in the Convex backend.
 *
 * @param email - The email address to validate
 * @returns true if the email format is valid
 */
export function isValidEmail(email: string): boolean {
	if (email.length > 254) return false;
	return sharedIsValidEmail(email);
}

/**
 * Validate that a string looks like a valid Convex document ID.
 * Convex IDs are URL-safe base64 strings, typically 10+ characters.
 */
export function isValidConvexId(id: string): boolean {
	return /^[a-zA-Z0-9_-]{10,}$/.test(id);
}

/**
 * Validate string length and throw if exceeded.
 *
 * @param value - The string to validate
 * @param maxLen - Maximum allowed length
 * @param fieldName - Name of the field (for error messages)
 */
export function validateStringLength(value: string, maxLen: number, fieldName: string): void {
	if (value.length > maxLen) {
		throw new Error(`${fieldName} must be at most ${maxLen} characters`);
	}
}

/** Standard length limits for common fields */
export const STRING_LIMITS = {
	NAME: 200,
	SUBJECT: 1000,
	DESCRIPTION: 5000,
	EVENT_NAME: 100,
	URL: 2000,
	FORM_FIELD_VALUE: 10000,
} as const;

/**
 * Validate that a URL is safe for redirect (http/https only, valid hostname).
 * Prevents open redirect attacks via javascript:, data:, or other dangerous protocols.
 * Also rejects URLs with credentials (user:pass@host) that could confuse browsers.
 */
export function isSafeRedirectUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol)) {
			return false;
		}
		if (!parsed.hostname) {
			return false;
		}
		// Reject URLs with embedded credentials (e.g., https://user:pass@evil.com)
		if (parsed.username || parsed.password) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Sanitize a value for use in email headers (From name, Reply-To, etc.).
 * Strips control characters, newlines, and null bytes that could enable header injection.
 * Limits length to 200 characters.
 */
export function sanitizeEmailHeaderValue(value: string): string {
	return value
		// Strip control characters (U+0000–U+001F, U+007F, U+0080–U+009F) except space
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		// Collapse whitespace
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

/**
 * Wrap a promise with a timeout. Rejects if the promise doesn't resolve within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, msg = 'Operation timed out'): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
	]);
}
