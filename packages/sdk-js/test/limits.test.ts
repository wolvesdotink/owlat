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

	it('reads the count of one template and one address', async () => {
		const limits: SendLimits = {
			dailySends: {
				isEnabled: true,
				limit: 50_000,
				used: 3,
				remaining: 49_997,
				resetsAt: '2026-11-24T00:00:00.000Z',
			},
			recipientSends: {
				isEnabled: true,
				limit: 5,
				windowSeconds: 3600,
				usage: {
					email: 'ada@example.com',
					templateId: 'k57t3mplate000000000000000000',
					slug: 'password-reset',
					isExempt: false,
					used: 5,
					remaining: 0,
					resetsAt: '2026-11-23T16:30:00.000Z',
				},
			},
		};
		const spy = mockFetch({
			status: 200,
			body: { data: limits },
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		await expect(
			createTestClient().limits.get({ email: 'ada@example.com', slug: 'password-reset' })
		).resolves.toEqual(limits);
		const url = new URL(String(spy.mock.calls[0]![0]));
		expect(url.pathname).toBe('/api/v1/limits');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			email: 'ada@example.com',
			slug: 'password-reset',
		});
	});

	it('names the template by ID when given one', async () => {
		const spy = mockFetch({
			status: 200,
			body: {
				data: {
					dailySends: {
						isEnabled: false,
						limit: 1,
						used: null,
						remaining: null,
						resetsAt: null,
					},
					recipientSends: { isEnabled: true, limit: 5, windowSeconds: 3600 },
				},
			},
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		await createTestClient().limits.get({ email: 'ada@example.com', transactionalId: 'k57t3' });
		const url = new URL(String(spy.mock.calls[0]![0]));
		expect(Object.fromEntries(url.searchParams)).toEqual({
			email: 'ada@example.com',
			transactionalId: 'k57t3',
		});
	});
});
