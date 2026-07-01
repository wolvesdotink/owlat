import { describe, it, expect } from 'vitest';
import {
	pickAdjacentMessageId,
	POSTBOX_AUTO_ADVANCE_DEFAULT,
	POSTBOX_AUTO_ADVANCE_OPTIONS,
} from '../postboxAutoAdvance';

const ids = ['a', 'b', 'c', 'd'];

describe('pickAdjacentMessageId', () => {
	describe("mode 'next'", () => {
		it('picks the following id from the middle of the list', () => {
			expect(pickAdjacentMessageId(ids, 'b', 'next')).toBe('c');
		});

		it('picks the second id when the first is triaged', () => {
			expect(pickAdjacentMessageId(ids, 'a', 'next')).toBe('b');
		});

		it('falls back to null (back-to-list) at the end of the list', () => {
			expect(pickAdjacentMessageId(ids, 'd', 'next')).toBeNull();
		});
	});

	describe("mode 'previous'", () => {
		it('picks the preceding id from the middle of the list', () => {
			expect(pickAdjacentMessageId(ids, 'c', 'previous')).toBe('b');
		});

		it('falls back to null (back-to-list) at the start of the list', () => {
			expect(pickAdjacentMessageId(ids, 'a', 'previous')).toBeNull();
		});
	});

	describe("mode 'back-to-list'", () => {
		it('always returns null, even with adjacent ids available', () => {
			expect(pickAdjacentMessageId(ids, 'b', 'back-to-list')).toBeNull();
		});
	});

	describe('degenerate inputs', () => {
		it('returns null when the current id is not in the list', () => {
			expect(pickAdjacentMessageId(ids, 'zz', 'next')).toBeNull();
			expect(pickAdjacentMessageId(ids, 'zz', 'previous')).toBeNull();
		});

		it('returns null for an empty list', () => {
			expect(pickAdjacentMessageId([], 'a', 'next')).toBeNull();
		});

		it('returns null for a single-item list in both directions', () => {
			expect(pickAdjacentMessageId(['a'], 'a', 'next')).toBeNull();
			expect(pickAdjacentMessageId(['a'], 'a', 'previous')).toBeNull();
		});
	});
});

describe('auto-advance constants', () => {
	it("defaults to 'next'", () => {
		expect(POSTBOX_AUTO_ADVANCE_DEFAULT).toBe('next');
	});

	it('offers exactly the three documented modes', () => {
		expect(POSTBOX_AUTO_ADVANCE_OPTIONS.map((o) => o.value)).toEqual([
			'next',
			'previous',
			'back-to-list',
		]);
	});
});
