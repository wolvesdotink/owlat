// Shared utility functions
export { getColumnWidths } from './columnWidths';
export { sanitizeCsvCell } from './csv';
export { gradientToCss, gradientToCssOrUndefined } from './gradient';
export { generateId } from './id';
export { normalizeError } from './errors';
export { capitalize, initials, truncate } from './strings';

// Validation utilities
export {
	// Regex patterns
	emailRegex,
	domainRegex,
	urlRegex,
	phoneRegex,
	slugRegex,
	// Validation functions
	isValidEmail,
	isValidDomain,
	isValidUrl,
	isValidPhone,
	isValidSlug,
	isEmpty,
	isNonEmptyString,
	toSlug,
} from './validation';
