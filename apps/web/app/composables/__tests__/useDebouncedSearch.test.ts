import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { useDebouncedSearch } from '../useDebouncedSearch';

describe('useDebouncedSearch', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('initialization', () => {
		it('starts with empty query and debouncedQuery', () => {
			const { query, debouncedQuery } = useDebouncedSearch();
			expect(query.value).toBe('');
			expect(debouncedQuery.value).toBe('');
		});

		it('exposes aliases searchQuery and debouncedSearch', () => {
			const { searchQuery, debouncedSearch, query, debouncedQuery } = useDebouncedSearch();
			expect(searchQuery).toBe(query);
			expect(debouncedSearch.value).toBe(debouncedQuery.value);
		});
	});

	describe('debounce timing', () => {
		it('does not update debouncedQuery immediately', async () => {
			const { query, debouncedQuery } = useDebouncedSearch(300);
			query.value = 'hello';
			await nextTick();

			expect(debouncedQuery.value).toBe('');
		});

		it('updates debouncedQuery after the delay', async () => {
			const { query, debouncedQuery } = useDebouncedSearch(300);
			query.value = 'hello';
			await nextTick();

			vi.advanceTimersByTime(300);
			expect(debouncedQuery.value).toBe('hello');
		});

		it('resets the timer on rapid changes', async () => {
			const { query, debouncedQuery } = useDebouncedSearch(300);

			query.value = 'h';
			await nextTick();
			vi.advanceTimersByTime(200);

			query.value = 'he';
			await nextTick();
			vi.advanceTimersByTime(200);

			// Only 200ms since last change, should not have updated yet
			expect(debouncedQuery.value).toBe('');

			vi.advanceTimersByTime(100);
			expect(debouncedQuery.value).toBe('he');
		});

		it('uses custom delay', async () => {
			const { query, debouncedQuery } = useDebouncedSearch(500);
			query.value = 'test';
			await nextTick();

			vi.advanceTimersByTime(300);
			expect(debouncedQuery.value).toBe('');

			vi.advanceTimersByTime(200);
			expect(debouncedQuery.value).toBe('test');
		});
	});

	describe('clear', () => {
		it('resets both query and debouncedQuery', async () => {
			const { query, debouncedQuery, clear } = useDebouncedSearch(300);

			query.value = 'search';
			await nextTick();
			vi.advanceTimersByTime(300);
			expect(debouncedQuery.value).toBe('search');

			clear();
			expect(query.value).toBe('');
			expect(debouncedQuery.value).toBe('');
		});

		it('cancels pending debounce', async () => {
			const { query, debouncedQuery, clear } = useDebouncedSearch(300);
			query.value = 'search';
			await nextTick();

			clear();
			vi.advanceTimersByTime(300);
			expect(debouncedQuery.value).toBe('');
		});
	});

	describe('setImmediate', () => {
		it('sets both values immediately', () => {
			const { query, debouncedQuery, setImmediate: setImm } = useDebouncedSearch(300);
			setImm('instant');
			expect(query.value).toBe('instant');
			expect(debouncedQuery.value).toBe('instant');
		});

		it('cancels any pending debounce', async () => {
			const { query, debouncedQuery, setImmediate: setImm } = useDebouncedSearch(300);
			query.value = 'pending';
			await nextTick();

			setImm('instant');
			vi.advanceTimersByTime(300);

			// Should still be 'instant', not overwritten by the pending 'pending'
			expect(debouncedQuery.value).toBe('instant');
		});
	});
});
