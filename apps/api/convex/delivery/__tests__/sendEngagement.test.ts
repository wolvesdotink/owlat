import { describe, expect, it } from 'vitest';
import {
	hasClicked,
	hasOpened,
	hasReachedDelivered,
	type SendEngagementFields,
} from '../sendEngagement';

const T = 1_700_000_000_000;

describe('sendEngagement predicates', () => {
	it('counts an opened-then-bounced send as delivered and opened', () => {
		// Current status would be `bounced`; only the timestamps remember the
		// open. The predicates never look at status.
		const send: SendEngagementFields = { deliveredAt: T, openedAt: T + 1_000 };
		expect(hasReachedDelivered(send)).toBe(true);
		expect(hasOpened(send)).toBe(true);
		expect(hasClicked(send)).toBe(false);
	});

	it('counts an opened send without deliveredAt as delivered', () => {
		const send: SendEngagementFields = { openedAt: T };
		expect(hasReachedDelivered(send)).toBe(true);
	});

	it('counts clickedLinks without clickedAt as clicked, and so as delivered', () => {
		// A reader click on a row that had already bounced or complained adds a
		// clickedLinks entry but leaves clickedAt unset.
		const send: SendEngagementFields = {
			clickedLinks: [{ url: 'https://example.com', clickedAt: T }],
		};
		expect(hasClicked(send)).toBe(true);
		expect(hasReachedDelivered(send)).toBe(true);
		expect(hasOpened(send)).toBe(false);
	});

	it('counts clickedAt alone as clicked', () => {
		expect(hasClicked({ clickedAt: T })).toBe(true);
	});

	it('treats an empty clickedLinks array as not clicked', () => {
		expect(hasClicked({ clickedLinks: [] })).toBe(false);
	});

	it('does not count a status-only row with no timestamps as delivered', () => {
		// A row whose status says `delivered` but that carries no delivery
		// evidence: the old status-based heatmap rule counted it, the
		// timestamp rule does not.
		const row = { status: 'delivered' as const };
		expect(hasReachedDelivered(row)).toBe(false);
		expect(hasOpened(row)).toBe(false);
		expect(hasClicked(row)).toBe(false);
	});

	it('narrows openedAt to a number', () => {
		const sends: SendEngagementFields[] = [{ openedAt: T + 5 }, {}, { openedAt: T }];
		const opened = sends.filter(hasOpened);
		// Compiles without a fallback: hasOpened is a type guard.
		expect(opened.map((s) => s.openedAt - T)).toEqual([5, 0]);
	});
});
