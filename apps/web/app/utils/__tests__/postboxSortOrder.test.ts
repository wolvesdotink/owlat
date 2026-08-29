/**
 * Postbox list sort-order derivations: a stored value normalises to a valid
 * order (defaulting to newest), the toggle alternates, and the read argument
 * omits the default entirely so a user on it keeps the pre-existing query
 * shape.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_SORT_ORDER_DEFAULT,
	nextPostboxSortOrder,
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

describe('nextPostboxSortOrder', () => {
	it('alternates between the two orders', () => {
		expect(nextPostboxSortOrder('newest')).toBe('oldest');
		expect(nextPostboxSortOrder('oldest')).toBe('newest');
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
