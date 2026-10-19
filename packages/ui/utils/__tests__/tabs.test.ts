import { describe, expect, it } from 'vitest';
import { selectedTabValue, tabElementId, tabPanelAttrs } from '../tabs';

const TABS = [
	{ value: 'overview', label: 'Overview' },
	{ value: 'review', label: 'Review' },
];

describe('selectedTabValue', () => {
	it('keeps a value that names a tab', () => {
		expect(selectedTabValue(TABS, 'review')).toBe('review');
	});

	it('falls back to the first tab for a missing or unknown value', () => {
		expect(selectedTabValue(TABS, undefined)).toBe('overview');
		expect(selectedTabValue(TABS, 'gone')).toBe('overview');
	});

	it('has nothing to select without tabs', () => {
		expect(selectedTabValue([], 'review')).toBeUndefined();
	});
});

describe('tabElementId', () => {
	it('keeps plain values readable', () => {
		expect(tabElementId('p1', 'auto-archived')).toBe('p1-tab-auto-archived');
	});

	it('never yields whitespace, so the id stays one IDREF', () => {
		expect(tabElementId('p1', 'a b\tc')).not.toMatch(/\s/);
	});

	it('keeps distinct values on distinct ids', () => {
		const values = ['a b', 'a_b', 'a_20_b', 'a.b', 'a-b', 'ab', 'ä'];
		const ids = values.map((value) => tabElementId('p1', value));
		expect(new Set(ids).size).toBe(values.length);
	});
});

describe('tabPanelAttrs', () => {
	it('labels the panel by the selected tab', () => {
		expect(tabPanelAttrs('p1', TABS, 'review')).toEqual({
			id: 'p1',
			role: 'tabpanel',
			tabindex: 0,
			'aria-labelledby': 'p1-tab-review',
		});
	});

	it('labels the panel by the fallback tab, as UiTabs selects it', () => {
		expect(tabPanelAttrs('p1', TABS, undefined)['aria-labelledby']).toBe('p1-tab-overview');
	});

	it('names no tab when there is none', () => {
		expect(tabPanelAttrs('p1', [], undefined)).toEqual({ id: 'p1', role: 'tabpanel', tabindex: 0 });
	});
});
