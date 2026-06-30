import { describe, it, expect } from 'vitest';
import { deduplicateContactsByEmail } from '../contactHelpers';

describe('deduplicateContactsByEmail', () => {
	it('returns all contacts when emails are unique', () => {
		const contacts = [
			{ email: 'a@test.com', name: 'A' },
			{ email: 'b@test.com', name: 'B' },
			{ email: 'c@test.com', name: 'C' },
		];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique).toHaveLength(3);
		expect(result.duplicateCount).toBe(0);
	});

	it('deduplicates case-insensitively', () => {
		const contacts = [
			{ email: 'John@Test.com', name: 'John1' },
			{ email: 'john@test.com', name: 'John2' },
		];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique).toHaveLength(1);
		expect(result.unique[0]!.name).toBe('John1'); // keeps first occurrence
		expect(result.duplicateCount).toBe(1);
	});

	it('trims whitespace from emails', () => {
		const contacts = [
			{ email: '  test@test.com  ', name: 'First' },
			{ email: 'test@test.com', name: 'Second' },
		];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique).toHaveLength(1);
		expect(result.duplicateCount).toBe(1);
	});

	it('counts all duplicates correctly', () => {
		const contacts = [
			{ email: 'a@test.com', name: 'A1' },
			{ email: 'a@test.com', name: 'A2' },
			{ email: 'a@test.com', name: 'A3' },
			{ email: 'b@test.com', name: 'B1' },
		];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique).toHaveLength(2);
		expect(result.duplicateCount).toBe(2);
	});

	it('returns empty array for empty input', () => {
		const result = deduplicateContactsByEmail([]);
		expect(result.unique).toHaveLength(0);
		expect(result.duplicateCount).toBe(0);
	});

	it('skips contacts with empty email', () => {
		const contacts = [
			{ email: '', name: 'Empty' },
			{ email: 'a@test.com', name: 'Valid' },
		];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique).toHaveLength(1);
		expect(result.unique[0]!.name).toBe('Valid');
		expect(result.duplicateCount).toBe(0);
	});

	it('handles single contact', () => {
		const contacts = [{ email: 'solo@test.com', name: 'Solo' }];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique).toHaveLength(1);
		expect(result.duplicateCount).toBe(0);
	});

	it('preserves original contact objects', () => {
		const contacts = [
			{ email: 'a@test.com', name: 'A', extra: 'data' },
			{ email: 'b@test.com', name: 'B', extra: 'more' },
		];
		const result = deduplicateContactsByEmail(contacts);
		expect(result.unique[0]).toBe(contacts[0]); // same reference
		expect(result.unique[1]).toBe(contacts[1]);
	});
});
