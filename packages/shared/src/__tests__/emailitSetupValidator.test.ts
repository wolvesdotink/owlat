import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEmailitKey } from '../emailitSetupValidator';

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

describe('validateEmailitKey', () => {
	it('probes the read-only domains endpoint with the bearer token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(validateEmailitKey('em_test')).resolves.toEqual({
			ok: true,
			message: 'Emailit key accepted.',
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.emailit.com/v2/domains',
			expect.objectContaining({
				headers: { Authorization: 'Bearer em_test' },
				signal: expect.any(AbortSignal),
			})
		);
	});

	it.each([401, 403])('reports an authentication rejection for HTTP %s', async (status) => {
		global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status })) as typeof fetch;

		await expect(validateEmailitKey('bad')).resolves.toEqual({
			ok: false,
			message: 'Emailit rejected the key.',
		});
	});

	it('reports bounded provider and network failures without exposing the key', async () => {
		global.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('{}', { status: 503 }))
			.mockRejectedValueOnce(new Error('secret network unavailable')) as typeof fetch;

		await expect(validateEmailitKey('secret')).resolves.toEqual({
			ok: false,
			message: 'Emailit returned HTTP 503.',
		});
		await expect(validateEmailitKey('secret')).resolves.toEqual({
			ok: false,
			message: 'Emailit request failed: [redacted] network unavailable',
		});
	});
});
