/**
 * Anchor-based range selection + the header checkbox's tri-state. Pure index
 * math over the id order the list renders.
 */
import { describe, it, expect } from 'vitest';
import { headerSelectionState, rangeBetween } from '../postboxRangeSelect';

const PAGE = ['a', 'b', 'c', 'd', 'e'];

describe('headerSelectionState', () => {
	it('is none for an empty page, even with a selection carried over', () => {
		expect(headerSelectionState([], new Set(['a']))).toBe('none');
	});

	it('is none when nothing on the page is picked', () => {
		expect(headerSelectionState(PAGE, new Set())).toBe('none');
		expect(headerSelectionState(PAGE, new Set(['zz']))).toBe('none');
	});

	it('is partial for some and all for every row on the page', () => {
		expect(headerSelectionState(PAGE, new Set(['b', 'c']))).toBe('partial');
		expect(headerSelectionState(PAGE, new Set(PAGE))).toBe('all');
	});

	it('stays "all" when the selection holds rows beyond the page', () => {
		// A "select all matching" answer covers the page and then some.
		expect(headerSelectionState(PAGE, new Set([...PAGE, 'f', 'g']))).toBe('all');
	});
});

describe('rangeBetween', () => {
	it('returns the inclusive span in list order, whichever way round', () => {
		expect(rangeBetween(PAGE, 'b', 'd')).toEqual(['b', 'c', 'd']);
		expect(rangeBetween(PAGE, 'd', 'b')).toEqual(['b', 'c', 'd']);
	});

	it('returns just the row when the anchor is the target', () => {
		expect(rangeBetween(PAGE, 'c', 'c')).toEqual(['c']);
	});

	it('degrades to the target alone when there is no anchor yet', () => {
		expect(rangeBetween(PAGE, null, 'c')).toEqual(['c']);
	});

	it('degrades to the target alone when the anchor has left the page', () => {
		// The anchored row was archived out from under the selection: a range
		// must not silently grow to span everything above the target.
		expect(rangeBetween(PAGE, 'gone', 'c')).toEqual(['c']);
	});

	it('selects nothing when the target itself is not on the page', () => {
		expect(rangeBetween(PAGE, 'a', 'gone')).toEqual([]);
	});
});
