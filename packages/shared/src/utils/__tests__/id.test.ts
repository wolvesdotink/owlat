import { describe, it, expect } from 'vitest';
import { generateId } from '../id';

describe('generateId', () => {
	it('returns a string with the default "id" prefix', () => {
		const id = generateId();
		expect(id).toMatch(/^id-\d+-[a-z0-9]+$/);
	});

	it('uses a custom prefix', () => {
		const id = generateId('block');
		expect(id.startsWith('block-')).toBe(true);
	});

	it('includes a timestamp component', () => {
		const before = Date.now();
		const id = generateId();
		const after = Date.now();

		const parts = id.split('-');
		const timestamp = Number(parts[1]);
		expect(timestamp).toBeGreaterThanOrEqual(before);
		expect(timestamp).toBeLessThanOrEqual(after);
	});

	it('generates unique IDs on consecutive calls', () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateId()));
		expect(ids.size).toBe(100);
	});

	it('has a random suffix of up to 7 characters', () => {
		const id = generateId();
		const parts = id.split('-');
		const randomPart = parts[2]!;
		expect(randomPart.length).toBeGreaterThan(0);
		expect(randomPart.length).toBeLessThanOrEqual(7);
	});
});
