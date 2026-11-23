import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ForbiddenError, type DeliveryStatus, type DeliveryStatusReason } from '../src';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

const SUSPENDED: DeliveryStatus = {
	level: 'error',
	reasonCode: 'sending_suspended',
	explanation: 'Sending is suspended on this instance.',
	fix: { route: '/dashboard/admin/operator', who: 'platform_admin' },
	domains: [{ domain: 'mail.example.com', status: 'verified' }],
	rates: {
		windowDays: 30,
		sent: 1000,
		bounce: { ratePct: 6, limitPct: 2, isOver: true },
		complaint: { ratePct: 0.2, limitPct: 0.1, isOver: true },
	},
	sendingHold: {
		status: 'suspended',
		since: '2026-11-20T09:00:00.000Z',
		detail: 'Auto-suspended: bounce rate 6% over the 2% limit',
	},
};

describe('StatusResource', () => {
	it('GETs /api/v1/status and returns how sending stands', async () => {
		const spy = mockFetch({ body: { data: SUSPENDED }, headers: TEST_RATE_LIMIT_HEADERS });

		const status = await createTestClient().status.get();

		expect(status).toEqual(SUSPENDED);
		const [url, init] = spy.mock.calls[0]!;
		expect(new URL(String(url)).pathname).toBe('/api/v1/status');
		expect(init?.method).toBe('GET');
		expectTypeOf(status.reasonCode).toEqualTypeOf<DeliveryStatusReason>();
	});

	it('throws ForbiddenError naming the scope for a key without status:read', async () => {
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
