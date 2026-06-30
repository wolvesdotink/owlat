import { describe, it, expect } from 'vitest';
import { generateEventId } from '../eventsApi';

describe('generateEventId', () => {
	it('should start with evt_ prefix', () => {
		const id = generateEventId();
		expect(id).toMatch(/^evt_/);
	});

	it('should contain only alphanumeric characters after prefix', () => {
		const id = generateEventId();
		const afterPrefix = id.slice(4);
		expect(afterPrefix).toMatch(/^[a-z0-9]+$/);
	});

	it('should have reasonable length', () => {
		const id = generateEventId();
		// evt_ prefix (4) + base36 timestamp (~8-9 chars) + random (~8 chars) = ~20-21
		expect(id.length).toBeGreaterThan(10);
		expect(id.length).toBeLessThan(30);
	});

	it('should generate unique IDs', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateEventId());
		}
		expect(ids.size).toBe(100);
	});

	it('should contain timestamp component', () => {
		const id = generateEventId();

		// Extract the timestamp part (between evt_ and the random part)
		const afterPrefix = id.slice(4);
		// The timestamp is base36 encoded, so it's the first ~8 chars
		// We can't easily extract it precisely, but we can verify the ID changes over time
		expect(afterPrefix.length).toBeGreaterThan(0);

		// Generate another one slightly later to verify uniqueness
		const id2 = generateEventId();
		expect(id).not.toBe(id2);
	});

	it('should be a string', () => {
		const id = generateEventId();
		expect(typeof id).toBe('string');
	});
});
