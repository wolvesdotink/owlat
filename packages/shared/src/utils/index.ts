// Shared utility functions
export { getColumnWidths } from './columnWidths';
export { sanitizeCsvCell } from './csv';
export { gradientToCss, gradientToCssOrUndefined } from './gradient';
export { generateId } from './id';
export { errorMessage, normalizeError } from './errors';
export { isPlainObject, isRecord } from './guards';
export { normalizeDomain } from './normalizeDomain';
export { sleep } from './sleep';
export { createAdminConvexClient } from './convexAdminClient';
export { capitalize, initials, truncate } from './strings';

// Validation utilities
export {
	// Regex patterns
	emailRegex,
	domainRegex,
	slugRegex,
	// Validation functions
	isValidEmail,
	isValidDomain,
	isValidUrl,
	isEmpty,
	toSlug,
} from './validation';
