import { describe, expect, it } from 'vitest';
import { readStoredValue } from '../useLocalStorage';
import {
	readStoredBoolean,
	readStoredChoice,
	readStoredFiniteNumber,
	readStoredStringList,
} from '~/utils/storedValue';

/** A storage holding `raw` under every key. */
const holding = (raw: string | null) => ({ getItem: () => raw });

describe('readStoredValue', () => {
	it('reads a stored value the reader accepts', () => {
		expect(readStoredValue(holding('true'), 'k', false, readStoredBoolean)).toBe(true);
		expect(readStoredValue(holding('["a","b"]'), 'k', [], readStoredStringList)).toEqual([
			'a',
			'b',
		]);
	});

	it.each([
		['no entry', null],
		['text that is not JSON', 'yes'],
		['JSON of another type', '"true"'],
		['null', 'null'],
	])('reads %s as the default', (_case, raw) => {
		expect(readStoredValue(holding(raw), 'k', false, readStoredBoolean)).toBe(false);
	});

	it('reads the default from a storage that throws', () => {
		const blocked = {
			getItem: () => {
				throw new DOMException('denied', 'SecurityError');
			},
		};
		expect(readStoredValue(blocked, 'k', 3, readStoredFiniteNumber)).toBe(3);
	});

	it('reads a choice this build no longer offers as the default', () => {
		const sorts = readStoredChoice(['recent', 'priority'] as const);
		expect(readStoredValue(holding('"priority"'), 'k', 'recent', sorts)).toBe('priority');
		expect(readStoredValue(holding('"oldest"'), 'k', 'recent', sorts)).toBe('recent');
		expect(readStoredValue(holding('1'), 'k', 'recent', sorts)).toBe('recent');
	});
});

describe('stored value readers', () => {
	it('accept only their own type', () => {
		expect(readStoredBoolean(false)).toBe(false);
		expect(readStoredBoolean(0)).toBeUndefined();
		expect(readStoredFiniteNumber(4)).toBe(4);
		expect(readStoredFiniteNumber('4')).toBeUndefined();
		expect(readStoredFiniteNumber(Number.NaN)).toBeUndefined();
		expect(readStoredStringList([])).toEqual([]);
		expect(readStoredStringList(['a', 1])).toBeUndefined();
		expect(readStoredStringList({ 0: 'a' })).toBeUndefined();
	});
});
