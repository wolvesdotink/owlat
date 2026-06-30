/**
 * Unit tests for the RFC 2971 ID `name` extraction used to populate the
 * app-password `lastUsedUa`. The line parser hands the `(...)` list to the
 * module as one opaque token with the inner quotes intact, so these cases
 * mirror that representation.
 */

import { describe, it, expect } from 'vitest';
import { parseClientName } from '../commands/id/index.js';

describe('parseClientName', () => {
	it('extracts the name value from a parameter list', () => {
		expect(
			parseClientName(['("name" "Thunderbird" "version" "115.0")']),
		).toBe('Thunderbird');
	});

	it('is case-insensitive on the name key', () => {
		expect(parseClientName(['("NAME" "Apple Mail")'])).toBe('Apple Mail');
	});

	it('finds name regardless of position in the list', () => {
		expect(
			parseClientName(['("os" "macOS" "name" "Outlook" "version" "16")']),
		).toBe('Outlook');
	});

	it('returns null for a NIL list', () => {
		expect(parseClientName(['NIL'])).toBeNull();
	});

	it('returns null when no args are present', () => {
		expect(parseClientName([])).toBeNull();
	});

	it('returns null when there is no name field', () => {
		expect(parseClientName(['("version" "1.0")'])).toBeNull();
	});

	it('returns null when the name value is empty', () => {
		expect(parseClientName(['("name" "")'])).toBeNull();
	});

	it('truncates an absurdly long client name', () => {
		const long = 'A'.repeat(500);
		const parsed = parseClientName([`("name" "${long}")`]);
		expect(parsed).toHaveLength(120);
	});
});
