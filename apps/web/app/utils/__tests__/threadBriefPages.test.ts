/**
 * The brief's item pages merged (review round 4): a payment obligation past a
 * first page of 100 waiting items is found, the merged lists keep the "For
 * you" order, and the state says when pages are still loading or were cut.
 */
import { describe, expect, it } from 'vitest';
import { mergeBriefPages, nextCursorOf } from '../threadBriefPages';
import { briefView, DAY, item, T0 } from './threadBriefFixtures';

const waiting = Array.from({ length: 100 }, (_, i) =>
	item({
		id: `w${i}`,
		text: `They send part ${i}`,
		responsibility: 'them',
		primaryReaction: 'nudge',
	})
);
const payment = item({
	id: 'pay',
	text: 'Pay €38.08',
	facets: ['payment'],
	due: { phrase: 'by Friday', at: T0 + 2 * DAY, isAmbiguous: false },
});

function firstPage() {
	return briefView({
		forYou: [],
		waitingOnOthers: waiting,
		counts: { forYou: 1, forTeam: 0, waitingOnOthers: 100, unclear: 0, closed: 0, hidden: 0 },
		page: { cursor: 'c1', isDone: false, isClosedTruncated: false },
	});
}
function secondPage() {
	return briefView({
		forYou: [payment],
		waitingOnOthers: [],
		page: { cursor: 'c2', isDone: true, isClosedTruncated: false },
	});
}

describe('mergeBriefPages', () => {
	it('finds the payment obligation on the second page behind 100 waiting items', () => {
		const merged = mergeBriefPages(firstPage(), [secondPage()]);
		expect(merged.itemsState).toBe('complete');
		expect(merged.brief.forYou.map((i) => i.id)).toEqual(['pay']);
		expect(merged.brief.waitingOnOthers).toHaveLength(100);
		expect(merged.brief.counts.forYou).toBe(1);
	});

	it('says the lists are loading while a page is on its way', () => {
		const merged = mergeBriefPages(firstPage(), [undefined]);
		expect(merged.itemsState).toBe('loading');
		expect(merged.brief.forYou).toEqual([]);
	});

	it('says the lists are cut when the walk hits its bound', () => {
		const stillMore = {
			...secondPage(),
			page: { cursor: 'c3', isDone: false, isClosedTruncated: false },
		};
		expect(mergeBriefPages(firstPage(), [stillMore], 2).itemsState).toBe('truncated');
	});

	it('merges into the For you order and passes the closed cut on', () => {
		const first = {
			...firstPage(),
			forYou: [
				item({
					id: 'late',
					text: 'Later',
					due: { phrase: 'x', at: T0 + 9 * DAY, isAmbiguous: false },
				}),
			],
			page: { cursor: 'c1', isDone: false, isClosedTruncated: true },
		};
		const merged = mergeBriefPages(first, [secondPage()]);
		expect(merged.brief.forYou.map((i) => i.id)).toEqual(['pay', 'late']);
		expect(merged.isClosedTruncated).toBe(true);
	});

	it('reads the next cursor only from an unfinished page', () => {
		expect(nextCursorOf(firstPage())).toBe('c1');
		expect(nextCursorOf(secondPage())).toBeNull();
		expect(nextCursorOf(briefView())).toBeNull();
	});
});
