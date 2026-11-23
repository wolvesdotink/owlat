import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendLimits } from '../src';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('LimitsResource', () => {
	it('GETs the limits and reads a daily cap that is off, which counts nothing', async () => {
		const limits: SendLimits = {
			dailySends: { isEnabled: false, limit: 50_000, used: null, remaining: null, resetsAt: null },
			recipientSends: { isEnabled: true, limit: 5, windowSeconds: 3600 },
		};
		const spy = mockFetch({
			status: 200,
			body: { data: limits },
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		await expect(createTestClient().limits.get()).resolves.toEqual(limits);
		const [url, init] = spy.mock.calls[0]!;
		expect(new URL(String(url)).pathname).toBe('/api/v1/limits');
		expect(init?.method).toBe('GET');
	});
});
