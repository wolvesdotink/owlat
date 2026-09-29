import { describe, it, expect } from 'vitest';
import { shareStructure } from '../structuralSharing';

const row = (id: string, extra: Record<string, unknown> = {}) => ({
	_id: id,
	_creationTime: 1,
	subject: `subject ${id}`,
	labels: ['inbox'],
	...extra,
});

describe('shareStructure', () => {
	it('returns the previous value when the next one is deep-equal', () => {
		const prev = { threads: [row('a'), row('b')], nextCursor: 'c1' };
		const next = { threads: [row('a'), row('b')], nextCursor: 'c1' };

		expect(shareStructure(prev, next)).toBe(prev);
	});

	it('keeps unchanged rows and replaces the changed one', () => {
		const prev = [row('a'), row('b'), row('c')];
		const next = [row('a'), row('b', { subject: 'edited' }), row('c')];

		const shared = shareStructure(prev, next);

		expect(shared).not.toBe(prev);
		expect(shared).toEqual(next);
		expect(shared[0]).toBe(prev[0]);
		expect(shared[1]).not.toBe(prev[1]);
		expect(shared[1]!.subject).toBe('edited');
		expect(shared[2]).toBe(prev[2]);
		// The changed row still shares its own unchanged parts.
		expect(shared[1]!.labels).toBe(prev[1]!.labels);
	});

	it('matches documents by _id across inserts, removals and reorders', () => {
		const prev = [row('a'), row('b'), row('c')];
		const next = [row('new'), row('c'), row('a')];

		const shared = shareStructure(prev, next);

		expect(shared).toEqual(next);
		expect(shared[0]).toBe(next[0]);
		expect(shared[1]).toBe(prev[2]);
		expect(shared[2]).toBe(prev[0]);
	});

	it('does not reuse a row whose _id matches but whose content differs', () => {
		const prev = [row('a', { unread: true })];
		const next = [row('a', { unread: false })];

		const shared = shareStructure(prev, next);

		expect(shared[0]).not.toBe(prev[0]);
		expect(shared[0]!.unread).toBe(false);
	});

	it('treats an added or removed field as a change', () => {
		const prev = [row('a')];
		const added = [row('a', { snoozedUntil: 5 })];
		const removed = [{ _id: 'a', _creationTime: 1, subject: 'subject a' }];

		expect(shareStructure(prev, added)[0]).toEqual(added[0]);
		expect(shareStructure(prev, added)[0]).not.toBe(prev[0]);
		expect(shareStructure(prev, removed)[0]).toEqual(removed[0]);
		expect(shareStructure(prev, removed)[0]).not.toBe(prev[0]);
	});

	it('matches non-document arrays by position', () => {
		const prev = [
			{ day: 1, count: 3 },
			{ day: 2, count: 4 },
		];
		const next = [
			{ day: 1, count: 3 },
			{ day: 2, count: 5 },
		];

		const shared = shareStructure(prev, next);

		expect(shared[0]).toBe(prev[0]);
		expect(shared[1]).not.toBe(prev[1]);
		expect(shared).toEqual(next);
	});

	it('returns a new array when rows only get dropped from the end', () => {
		const prev = [row('a'), row('b')];
		const next = [row('a')];

		const shared = shareStructure(prev, next);

		expect(shared).not.toBe(prev);
		expect(shared).toHaveLength(1);
		expect(shared[0]).toBe(prev[0]);
	});

	it('compares primitives, bigint included, by value and takes other objects from next', () => {
		expect(shareStructure({ n: 1n, s: 'x' }, { n: 1n, s: 'x' })).toEqual({ n: 1n, s: 'x' });
		const prev = { n: 1n };
		expect(shareStructure(prev, { n: 1n })).toBe(prev);

		const bytes = new ArrayBuffer(4);
		const nextBytes = new ArrayBuffer(4);
		const shared = shareStructure({ bytes }, { bytes: nextBytes });
		expect(shared.bytes).toBe(nextBytes);
	});

	it('takes next as-is when there is nothing to share with', () => {
		const next = [row('a')];

		expect(shareStructure(undefined, next)).toBe(next);
		expect(shareStructure(null, next)).toBe(next);
		expect(shareStructure({ not: 'an array' }, next)).toBe(next);
		expect(shareStructure(next, null)).toBeNull();
	});
});
