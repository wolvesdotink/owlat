/**
 * Validation utilities and regex patterns.
 * Barrel re-export from @owlat/shared — allows `~/utils/validation` imports
 * without leaking the package boundary into every consumer.
 */

// Regex patterns
export {
	emailRegex,
	domainRegex,
	urlRegex,
	phoneRegex,
	slugRegex,
} from '@owlat/shared';

// Validation functions
export {
	isValidEmail,
	isValidDomain,
	isValidUrl,
	isValidPhone,
	isValidSlug,
	isEmpty,
	isNonEmptyString,
	toSlug,
} from '@owlat/shared';

// Email lookup-key normalization (trim + lowercase)
export { normalizeEmail } from '@owlat/shared';

// Re-export string helpers from shared strings (for backwards compatibility)
export { truncate, capitalize } from '@owlat/shared';
