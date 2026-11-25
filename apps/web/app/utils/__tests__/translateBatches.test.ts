import { describe, it, expect } from 'vitest';
import { translateBatches } from '../translateBatches';

describe('translateBatches', () => {
	it('splits at 50 items and keeps the order', () => {
		const items = Array.from({ length: 120 }, (_, i) => ({ id: String(i), text: 'x' }));
		const batches = translateBatches(items);
		expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
		expect(batches.flat()).toEqual(items);
	});

	it('splits before the text of a batch passes 100,000 characters', () => {
		const long = 'x'.repeat(60_000);
		const batches = translateBatches([{ text: long }, { text: long }, { text: 'y' }]);
		expect(batches.map((batch) => batch.length)).toEqual([1, 2]);
	});
});
