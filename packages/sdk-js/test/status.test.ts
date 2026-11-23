import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, type SendingHoldLift } from '../src';
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

	it('returns how a suspension lifts on the sending hold', async () => {
		const lift: SendingHoldLift = {
			mode: 'automatic',
			condition: {
				trigger: 'complaint_rate',
				domain: null,
				currentPct: 0.3,
				limitPct: 0.2,
				isClear: false,
				clearsAt: null,
			},
		};
		mockFetch({
			status: 200,
			body: {
				data: {
					level: 'error',
					reasonCode: 'sending_suspended',
					explanation: 'Sending is suspended.',
					fix: null,
					domains: [],
					rates: null,
					sendingHold: { status: 'suspended', since: null, detail: null, lift },
				},
			},
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		const status = await createTestClient().status.get();
		expect(status.sendingHold?.lift).toEqual(lift);
		expect(status.sendingHold?.lift.condition?.limitPct).toBe(0.2);
	});
});
