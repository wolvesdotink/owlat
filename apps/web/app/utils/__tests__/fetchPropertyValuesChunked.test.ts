import { describe, it, expect } from 'vitest';
import type { Id } from '@owlat/api/dataModel';
import {
	fetchPropertyValuesChunked,
	PROPERTY_VALUES_CHUNK_SIZE,
} from '../contactsCsv';

const idOf = (n: number) => `contact_${n}` as Id<'contacts'>;

describe('fetchPropertyValuesChunked', () => {
	it('never asks for more than the chunk size in a single call', async () => {
		const ids = Array.from({ length: 2500 }, (_, i) => idOf(i));
		const chunkSizes: number[] = [];

		await fetchPropertyValuesChunked(ids, async (chunk) => {
			chunkSizes.push(chunk.length);
			return {};
		});

		expect(chunkSizes.length).toBeGreaterThan(1);
		for (const size of chunkSizes) {
			expect(size).toBeLessThanOrEqual(PROPERTY_VALUES_CHUNK_SIZE);
		}
	});

	it('exports more contacts than a single call can serve and merges the full map', async () => {
		// Simulate the Convex per-transaction index-range-read cap: a single call
		// that receives more than ~2,048 ids throws, exactly as the real backend
		// did before this fix. Chunking must keep every call under that limit and
		// still return the complete property map for all contacts.
		const CAP = 2048;
		const ids = Array.from({ length: 5000 }, (_, i) => idOf(i));

		const merged = await fetchPropertyValuesChunked(ids, async (chunk) => {
			if (chunk.length > CAP) {
				throw new Error('index range read cap exceeded');
			}
			const part: Record<string, Record<string, string>> = {};
			for (const id of chunk) {
				part[id] = { plan: `p-${id}` };
			}
			return part;
		});

		expect(Object.keys(merged)).toHaveLength(ids.length);
		for (const id of ids) {
			expect(merged[id]).toEqual({ plan: `p-${id}` });
		}
	});

	it('returns an empty map for no contacts without calling the fetcher', async () => {
		let called = false;
		const merged = await fetchPropertyValuesChunked([], async () => {
			called = true;
			return {};
		});

		expect(called).toBe(false);
		expect(merged).toEqual({});
	});

	it('does not chunk when the id count fits in one call', async () => {
		const ids = Array.from({ length: 10 }, (_, i) => idOf(i));
		let calls = 0;

		await fetchPropertyValuesChunked(ids, async (chunk) => {
			calls += 1;
			expect(chunk).toHaveLength(10);
			return {};
		});

		expect(calls).toBe(1);
	});
});
