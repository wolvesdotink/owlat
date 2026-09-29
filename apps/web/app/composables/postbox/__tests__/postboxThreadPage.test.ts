import { describe, expect, it } from 'vitest';
import {
	THREAD_PAGE_BODIES,
	THREAD_PAGE_SIZE,
	earlierThreadPageArgs,
	mergeThreadPages,
	placeAnchorRow,
	threadPageArgs,
} from '../postboxThreadPage';

const row = (id: string, receivedAt = 0, note = '') => ({ _id: id, receivedAt, note });

describe('thread page args', () => {
	it('asks the newest page for the newest bodies and earlier pages for envelopes only', () => {
		expect(threadPageArgs('m1')).toEqual({
			messageId: 'm1',
			pageSize: THREAD_PAGE_SIZE,
			withBodies: THREAD_PAGE_BODIES,
		});
		expect(earlierThreadPageArgs('m1', 'c1')).toEqual({
			messageId: 'm1',
			pageSize: THREAD_PAGE_SIZE,
			withBodies: 0,
			cursor: 'c1',
		});
	});
});

describe('mergeThreadPages', () => {
	it('lays the pages out oldest first, envelopes before bodies within a page', () => {
		const merged = mergeThreadPages([
			{ envelopes: [row('c')], messages: [row('d'), row('e')] },
			{ envelopes: [row('a'), row('b')], messages: [] },
		]);
		expect(merged.map((r) => r._id)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('keeps the newer page copy of a message two pages hold', () => {
		const merged = mergeThreadPages([
			{ envelopes: [row('b', 0, 'newer')], messages: [row('c')] },
			{ envelopes: [row('a'), row('b', 0, 'older')], messages: [] },
		]);
		expect(merged.map((r) => `${r._id}${r.note}`)).toEqual(['a', 'bnewer', 'c']);
	});
});

describe('placeAnchorRow', () => {
	it('leaves a conversation that holds the opened message alone', () => {
		const rows = [row('a', 1), row('b', 2)];
		expect(placeAnchorRow(rows, row('a', 1, 'open row'))).toEqual(rows);
	});

	it('stands the opened row in at its place by date until its page loads', () => {
		const rows = [row('x', 10), row('y', 20)];
		expect(placeAnchorRow(rows, row('a', 5)).map((r) => r._id)).toEqual(['a', 'x', 'y']);
		expect(placeAnchorRow(rows, row('m', 15)).map((r) => r._id)).toEqual(['x', 'm', 'y']);
		expect(placeAnchorRow(rows, row('z', 25)).map((r) => r._id)).toEqual(['x', 'y', 'z']);
	});
});
