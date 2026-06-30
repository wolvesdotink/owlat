/**
 * Build a searchable text string from multiple fields.
 * Used for full-text search indexes on contacts, templates, campaigns, etc.
 */
export function buildSearchableText(...fields: (string | undefined | null)[]): string {
	return fields
		.map((f) => f ?? '')
		.join(' ')
		.toLowerCase()
		.trim();
}
