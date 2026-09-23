import { describe, it, expect } from 'vitest';
import { SEARCH_WALK_PAGE_BUDGET, searchWalkStep } from '../postboxSearchWalk';

const base = {
	resultCount: 0,
	hasMore: true,
	canLoadMore: true,
	isLoadingMore: false,
	hasError: false,
	pagesWalked: 0,
};

describe('searchWalkStep (#777)', () => {
	it('asks for the next page while pages come back empty', () => {
		expect(searchWalkStep(base)).toBe('load');
		expect(searchWalkStep({ ...base, pagesWalked: 5 })).toBe('load');
	});

	it('stops at the first match', () => {
		expect(searchWalkStep({ ...base, resultCount: 1 })).toBe('stop');
	});

	it('stops when the mailbox has nothing older', () => {
		expect(searchWalkStep({ ...base, hasMore: false, canLoadMore: false })).toBe('stop');
	});

	it('waits while a page is in flight, whatever the stale frontier says', () => {
		expect(searchWalkStep({ ...base, isLoadingMore: true })).toBe('wait');
		expect(searchWalkStep({ ...base, isLoadingMore: true, hasMore: false })).toBe('wait');
	});

	it('stops when more exists but there is no cursor to reach it', () => {
		expect(searchWalkStep({ ...base, canLoadMore: false })).toBe('stop');
	});

	it('stops when a page fails to load', () => {
		expect(searchWalkStep({ ...base, hasError: true })).toBe('stop');
	});

	it('hands control back once the page budget is spent', () => {
		expect(searchWalkStep({ ...base, pagesWalked: SEARCH_WALK_PAGE_BUDGET })).toBe('stop');
	});
});
