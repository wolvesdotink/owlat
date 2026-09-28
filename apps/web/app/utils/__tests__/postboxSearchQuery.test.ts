/**
 * The search chips' query editing: removing one operator from the raw box,
 * clearing every operator, and the chip labels.
 *
 * Removal used to run a regex over the raw text, which stopped at the first
 * space and left the tail of a quoted value (`subject:"quarterly report"` → a
 * stray `report"`) behind in the box. These pin that quoting survives an edit.
 * The grammar itself is tested in packages/shared (`mailSearch.test.ts`).
 */
import { describe, it, expect } from 'vitest';

import { parseSearchQuery } from '@owlat/shared/mailSearch';
import { removeSearchOperator, stripSearchOperators, describeChips } from '../postboxSearchQuery';

describe('removeSearchOperator', () => {
	it('removes a quoted operator whole, leaving no fragment behind', () => {
		expect(removeSearchOperator('from:sara subject:"quarterly report" hello', 'subject')).toBe(
			'from:sara hello'
		);
	});

	it('removes every occurrence of the operator', () => {
		expect(removeSearchOperator('from:sara from:bob hi', 'from')).toBe('hi');
	});

	it('preserves the quoting of what it keeps', () => {
		expect(removeSearchOperator('from:sara "exact phrase"', 'from')).toBe('"exact phrase"');
	});
});

describe('stripSearchOperators', () => {
	it('drops operators and keeps quoted free text intact', () => {
		expect(stripSearchOperators('from:sara subject:"q r" "exact phrase" hi')).toBe(
			'"exact phrase" hi'
		);
	});
});

describe('removeSearchOperator — negation and OR', () => {
	it('removes only the sign the chip carries', () => {
		// The `-from: noise` chip must not take `from: ines` with it.
		expect(removeSearchOperator('from:ines -from:noise', '-from')).toBe('from:ines');
		expect(removeSearchOperator('from:ines -from:noise', 'from')).toBe('-from:noise');
	});

	it('preserves the sign and the quoting of what it keeps', () => {
		expect(removeSearchOperator('to:a -subject:"q r"', 'to')).toBe('-subject:"q r"');
	});

	it('drops the OR left dangling by a removal', () => {
		expect(removeSearchOperator('from:ines OR from:mei', 'from')).toBe('');
		expect(removeSearchOperator('from:ines OR label:billing', 'from')).toBe('label:billing');
	});
});

describe('stripSearchOperators — negation and OR', () => {
	it('drops negated operators along with the positive ones', () => {
		expect(stripSearchOperators('-from:ines label:x hello')).toBe('hello');
	});

	it('does not leave a dangling OR behind', () => {
		expect(stripSearchOperators('from:a OR from:b hello')).toBe('hello');
	});
});

describe('describeChips', () => {
	it('renders the new operators, negation and both OR sides', () => {
		const chips = describeChips(parseSearchQuery('cc:legal larger:5M -from:ines OR label:billing'));
		expect(chips).toEqual([
			{ key: 'cc', label: 'cc: legal' },
			{ key: 'larger', label: 'larger: 5M' },
			{ key: '-from', label: '-from: ines' },
			{ key: 'label', label: 'label: billing' },
		]);
	});

	it('deduplicates a chip that both OR sides produce', () => {
		const chips = describeChips(parseSearchQuery('is:unread from:a OR is:unread from:b'));
		expect(chips.filter((c) => c.key === 'is')).toHaveLength(1);
	});
});
