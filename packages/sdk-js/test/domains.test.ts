import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../src';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('DomainsResource', () => {
	it('GETs /api/v1/domains and returns the domains', async () => {
		const domains = [
			{
				id: 'd1',
				domain: 'mail.example.com',
				status: 'pending',
				lastCheckedAt: null,
				records: [
					{
						purpose: 'dmarc',
						type: 'TXT',
						host: '_dmarc.mail.example.com',
						value: 'v=DMARC1; p=none',
						priority: null,
						state: 'missing',
						foundValue: null,
					},
				],
			},
		];
		const spy = mockFetch({
			status: 200,
			body: { data: domains },
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		expect(await createTestClient().domains.list()).toEqual(domains);
		const [url, options] = spy.mock.calls[0];
		expect(new URL(String(url)).pathname).toBe('/api/v1/domains');
		expect(options?.method).toBe('GET');
	});

	it('throws ForbiddenError with missing_scope for a key without status:read', async () => {
		mockFetch({
			status: 403,
			body: {
				error: {
					category: 'forbidden',
					message: 'This API key is missing the required scope: status:read',
					data: { reason: 'missing_scope', scope: 'status:read' },
				},
			},
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		const error = await createTestClient()
			.domains.list()
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ForbiddenError);
		expect((error as ForbiddenError).reason).toBe('missing_scope');
	});
});
