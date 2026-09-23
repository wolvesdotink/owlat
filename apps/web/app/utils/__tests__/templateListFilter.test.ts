import { describe, expect, it } from 'vitest';
import { parseTemplateTypeFilter, TEMPLATE_TYPE_FILTERS } from '~/utils/templateListFilter';

describe('parseTemplateTypeFilter', () => {
	it('accepts the two template types', () => {
		expect(parseTemplateTypeFilter('marketing')).toBe('marketing');
		expect(parseTemplateTypeFilter('transactional')).toBe('transactional');
	});

	it('falls back to all for a missing or unknown value', () => {
		expect(parseTemplateTypeFilter(undefined)).toBe('all');
		expect(parseTemplateTypeFilter('media')).toBe('all');
		expect(parseTemplateTypeFilter(null)).toBe('all');
	});

	it('reads the first of a repeated query param', () => {
		expect(parseTemplateTypeFilter(['transactional', 'marketing'])).toBe('transactional');
	});

	it('offers all first', () => {
		expect(TEMPLATE_TYPE_FILTERS[0]).toBe('all');
	});
});
