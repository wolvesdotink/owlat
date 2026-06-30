import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('EventsResource', () => {
	const eventResponse = {
		eventId: 'evt_123',
		contactId: 'c_456',
		eventName: 'purchase_completed',
		triggeredAutomations: 2,
		contactCreated: false,
	};

	describe('send', () => {
		it('should POST to /api/v1/events with correct body', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: eventResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.events.send({
				email: 'user@example.com',
				eventName: 'purchase_completed',
			});

			expect(result).toEqual(eventResponse);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/events');
			expect(options?.method).toBe('POST');
			expect(JSON.parse(options?.body as string)).toEqual({
				email: 'user@example.com',
				eventName: 'purchase_completed',
			});
		});

		it('should pass eventProperties through', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: eventResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.events.send({
				email: 'user@example.com',
				eventName: 'purchase_completed',
				eventProperties: {
					orderId: 'order_123',
					amount: 99.99,
				},
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body.eventProperties).toEqual({
				orderId: 'order_123',
				amount: 99.99,
			});
		});

		it('should pass createContactIfNotExists through', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: { ...eventResponse, contactCreated: true } },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.events.send({
				email: 'new@example.com',
				eventName: 'signup',
				createContactIfNotExists: true,
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body.createContactIfNotExists).toBe(true);
			expect(result.contactCreated).toBe(true);
		});
	});
});
