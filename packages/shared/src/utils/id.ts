/**
 * Generate a unique ID with an optional prefix
 * Format: {prefix}-{timestamp}-{random alphanumeric}
 *
 * @param prefix - Optional prefix for the ID (default: 'id')
 * @returns A unique string ID
 */
export function generateId(prefix: string = 'id'): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
