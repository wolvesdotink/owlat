import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../src';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('StatusResource', () => {
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
			.status.get()
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ForbiddenError);
		expect((error as ForbiddenError).reason).toBe('missing_scope');
	});
});
