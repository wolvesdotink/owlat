import { describe, it, expect } from 'vitest';
import { backendErrorMessage } from '../backend';

/**
 * What the CLI prints when the backend refuses.
 *
 * The `/seed/*`, `/dev/*` and `/sample-data/*` endpoints answer in the locked
 * `{ error: { category, message } }` envelope (ADR-0036), but the CLI ships
 * separately from the container it talks to, so the older `{ error: "…" }`
 * string must keep reading as a message rather than as `[object Object]`.
 */
describe('backendErrorMessage', () => {
	it('reads the message out of the error envelope', () => {
		expect(
			backendErrorMessage({ error: { category: 'unauthenticated', message: 'Unauthorized' } }, 'x')
		).toBe('Unauthorized');
	});

	it('still reads the older string form', () => {
		expect(backendErrorMessage({ error: 'Unauthorized' }, 'x')).toBe('Unauthorized');
	});

	it('falls back when the body carries no usable message', () => {
		expect(backendErrorMessage({}, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage({ error: {} }, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage({ error: '' }, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage(null, 'HTTP 500')).toBe('HTTP 500');
		expect(backendErrorMessage('nope', 'HTTP 500')).toBe('HTTP 500');
	});
});
