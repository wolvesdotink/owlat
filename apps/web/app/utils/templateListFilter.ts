/**
 * The templates list's type filter (#787), kept in the URL as `?type=`.
 * Pure so the URL parsing is unit-tested directly.
 */

export const TEMPLATE_TYPE_FILTERS = ['all', 'marketing', 'transactional'] as const;

export type TemplateTypeFilter = (typeof TEMPLATE_TYPE_FILTERS)[number];

/** Anything unknown (a stale link, a repeated param) falls back to "all". */
export function parseTemplateTypeFilter(value: unknown): TemplateTypeFilter {
	const raw = Array.isArray(value) ? value[0] : value;
	return raw === 'marketing' || raw === 'transactional' ? raw : 'all';
}
