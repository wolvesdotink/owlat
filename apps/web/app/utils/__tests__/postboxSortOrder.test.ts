/**
 * Postbox list sort-order derivations: a stored value normalises to a valid
 * order (defaulting to newest), the picker offers both orders as catalog keys,
 * and the read argument omits the default entirely so a user on it keeps the
 * pre-existing query shape.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_SORT_ORDER_DEFAULT,
	POSTBOX_SORT_ORDER_OPTIONS,
	postboxSortOrderArg,
	resolvePostboxSortOrder,
} from '../postboxSortOrder';

describe('resolvePostboxSortOrder', () => {
	it('defaults to newest for unset values', () => {
		expect(resolvePostboxSortOrder(undefined)).toBe('newest');
		expect(resolvePostboxSortOrder(null)).toBe('newest');
		expect(POSTBOX_SORT_ORDER_DEFAULT).toBe('newest');
	});

	it('passes through both valid orders', () => {
		expect(resolvePostboxSortOrder('newest')).toBe('newest');
		expect(resolvePostboxSortOrder('oldest')).toBe('oldest');
	});

	it('normalises an unknown stored value to newest', () => {
		expect(resolvePostboxSortOrder('largest')).toBe('newest');
	});
});

describe('POSTBOX_SORT_ORDER_OPTIONS', () => {
	it('offers both orders, newest first, as catalog keys', () => {
		expect(POSTBOX_SORT_ORDER_OPTIONS.map((o) => o.value)).toEqual(['newest', 'oldest']);
		expect(POSTBOX_SORT_ORDER_OPTIONS.every((o) => o.label.startsWith('shared.'))).toBe(true);
	});
});

describe('postboxSortOrderArg', () => {
	it('sends nothing for the default order', () => {
		// Absent = exactly today's behaviour: same query shape, same cursors.
		expect(postboxSortOrderArg('newest')).toBeUndefined();
	});

	it('sends the order once it differs from the default', () => {
		expect(postboxSortOrderArg('oldest')).toBe('oldest');
	});
});
