/**
 * Shared validation utilities and regex patterns
 * These core validators can be used across frontend and backend
 */

// ============================================================================
// Regex Patterns
// ============================================================================

/**
 * Email validation regex
 * Rejects: consecutive dots, leading/trailing dots in local/domain,
 * leading/trailing hyphens in domain labels, and requires 2+ char TLD.
 */
export const emailRegex = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

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
