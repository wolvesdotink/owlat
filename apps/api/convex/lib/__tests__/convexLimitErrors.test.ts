import { describe, expect, it } from 'vitest';
import { isTransactionLimitError } from '../convexLimitErrors';

const LIMITS_LINK = 'This is a Convex limit: https://docs.convex.dev/production/state/limits';

describe('isTransactionLimitError', () => {
	// The per-transaction wordings convex-test mirrors from the backend. Both the
	// contact-erasure walker and the workspace deletion's scheduler scan shrink on
	// these, so each one must read as a limit.
	it.each([
		'Read too much data in a single function execution (limit: 16777216 bytes).',
		'Scanned too many documents in a single function execution (limit: 32000).',
		'Wrote too much data in a single function execution (limit: 16777216 bytes).',
		'Wrote too many documents in a single function execution (limit: 16000).',
		'Too many index ranges read in a single function execution (limit: 4096).',
		'Scheduled too many functions in a single function execution (limit: 1000).',
		'Scheduled function arguments too large in a single function execution (limit: 16777216 bytes).',
		'Too many bytes read in a single function execution (limit: 16777216 bytes).',
	])('reads %s as a limit, with or without the limits link', (message) => {
		expect(isTransactionLimitError(message)).toBe(true);
		expect(isTransactionLimitError(`${message} ${LIMITS_LINK}`)).toBe(true);
	});

	it('reads the shorter phrases as a limit when the suffix is missing', () => {
		expect(isTransactionLimitError('Read too much data')).toBe(true);
		expect(isTransactionLimitError('Scheduled too many functions')).toBe(true);
		expect(isTransactionLimitError(`Uncaught Error: ${LIMITS_LINK}`)).toBe(true);
	});

	it.each([
		'Request timed out',
		'Your function ran for too long',
		'InvalidCursor: Tried to run a query starting from a cursor',
		'Only a single paginated query (`.paginate()`) is allowed per function execution. This is a Convex limit: https://docs.convex.dev/database/pagination',
		'ConvexError: invalid_state',
	])('leaves %s out, since a smaller batch cannot fix it', (message) => {
		expect(isTransactionLimitError(message)).toBe(false);
	});
});
