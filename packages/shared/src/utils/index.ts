// Shared utility functions
export {
	getColumnWidths,
	getColumnWidthPercents,
	isValidColumnWidths,
	setColumnWidth,
	MAX_COLUMN_COUNT,
	MIN_COLUMN_WIDTH_PERCENT,
} from './columnWidths';
export { sanitizeCsvCell } from './csv';
export { gradientToCss, gradientToCssOrUndefined } from './gradient';
export { generateId } from './id';
export { errorMessage } from './errors';
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
	// Validation functions
	isValidEmail,
	isValidDomain,
	isValidUrl,
	isEmpty,
	toSlug,
	isValidSlug,
} from './validation';
