import { describe, it, expect } from 'vitest';
import { normalizeRepeat, DEFAULT_ITEM_ALIAS } from '../blockRepeat';

describe('normalizeRepeat', () => {
	it('always emits an itemAlias so the renderer can build {{alias.key}} placeholders', () => {
		// Pre-fix bug: editor wrote only { variable }, leaving itemAlias undefined,
		// so the renderer searched for literal {{undefined.key}} and substituted nothing.
		const result = normalizeRepeat(undefined, { variable: 'products' });
		expect(result.itemAlias).toBe(DEFAULT_ITEM_ALIAS);
		expect(result.itemAlias).toBeTruthy();
		expect(result.variable).toBe('products');
	});

	it('defaults a brand-new repeat alias to "item"', () => {
		expect(normalizeRepeat(undefined, {}).itemAlias).toBe('item');
	});

	it('preserves the alias while changing the variable', () => {
		const result = normalizeRepeat({ variable: 'rows', itemAlias: 'row' }, { variable: 'lines' });
		expect(result).toEqual({ variable: 'lines', itemAlias: 'row' });
	});

	it('trims the alias and falls back to the default when blank', () => {
		expect(normalizeRepeat(undefined, { itemAlias: '  item ' }).itemAlias).toBe('item');
		expect(normalizeRepeat(undefined, { itemAlias: '   ' }).itemAlias).toBe(DEFAULT_ITEM_ALIAS);
	});

	it('keeps a positive integer maxItems and floors fractional input', () => {
		expect(normalizeRepeat(undefined, { variable: 'p', maxItems: 3 }).maxItems).toBe(3);
		expect(normalizeRepeat(undefined, { maxItems: 4.9 }).maxItems).toBe(4);
	});

	it('drops a non-positive or non-finite maxItems (treated as unlimited)', () => {
		expect(normalizeRepeat(undefined, { maxItems: 0 }).maxItems).toBeUndefined();
		expect(normalizeRepeat(undefined, { maxItems: -2 }).maxItems).toBeUndefined();
		expect(normalizeRepeat(undefined, { maxItems: Number.NaN }).maxItems).toBeUndefined();
	});

	it('clears maxItems when explicitly patched to undefined', () => {
		const result = normalizeRepeat({ variable: 'p', itemAlias: 'item', maxItems: 5 }, { maxItems: undefined });
		expect(result.maxItems).toBeUndefined();
	});
});
