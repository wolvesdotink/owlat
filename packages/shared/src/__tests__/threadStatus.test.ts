import { describe, it, expect } from 'vitest';
import {
	FILED_CATEGORIES,
	THREAD_STATUS_PRIORITY,
	deriveThreadStatus,
	isFiledCategory,
	mostUrgentStatus,
} from '../threadStatus';

describe('thread status rules', () => {
	it('ranks draft ready over needs-you over updated over waiting', () => {
		expect(deriveThreadStatus({ needsReply: { draftSlot: {} }, newSinceVisit: 3 })).toBe(
			'draft_ready'
		);
		expect(deriveThreadStatus({ needsReply: {}, newSinceVisit: 3 })).toBe('needs_you');
		expect(deriveThreadStatus({ followUp: { dueAt: 1 }, newSinceVisit: 0 })).toBe('needs_you');
		expect(deriveThreadStatus({ newSinceVisit: 2, followUp: {} })).toBe('updated');
		expect(deriveThreadStatus({ followUp: {}, newSinceVisit: 0 })).toBe('waiting');
		expect(deriveThreadStatus({ newSinceVisit: 0 })).toBeNull();
		expect(mostUrgentStatus(['waiting', null, 'updated', 'needs_you'])).toBe('needs_you');
		expect(mostUrgentStatus([null, undefined])).toBeNull();
	});

	it('treats a clarification draft as a ready draft', () => {
		expect(
			deriveThreadStatus({ needsReply: { clarification: { draft: {} } }, newSinceVisit: 0 })
		).toBe('draft_ready');
		expect(deriveThreadStatus({ needsReply: { clarification: null }, newSinceVisit: 0 })).toBe(
			'needs_you'
		);
	});

	it('pins the priority order', () => {
		expect([...THREAD_STATUS_PRIORITY]).toEqual(['draft_ready', 'needs_you', 'updated', 'waiting']);
	});
});

describe('filed categories', () => {
	it('lists the five kinds Today files away', () => {
		expect([...FILED_CATEGORIES]).toEqual([
			'newsletter',
			'notification',
			'receipt',
			'promotion',
			'spam',
		]);
	});

	it('recognises only filed labels', () => {
		expect(isFiledCategory('promotion')).toBe(true);
		expect(isFiledCategory('person')).toBe(false);
		expect(isFiledCategory('other')).toBe(false);
		expect(isFiledCategory(undefined)).toBe(false);
		expect(isFiledCategory('')).toBe(false);
	});
});
