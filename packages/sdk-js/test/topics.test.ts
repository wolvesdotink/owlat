import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';
import { ForbiddenError, ValidationError } from '../src/errors';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('TopicsResource', () => {
	describe('list', () => {
		const page = {
			data: [
				{
					id: 'topic_1',
					name: 'Product updates',
					description: null,
					requiresDoubleOptIn: true,
					createdAt: '2026-01-10T08:00:00.000Z',
				},
			],
			pagination: { limit: 10, totalItems: 11, cursor: 'next-page', isDone: false },
		};

		it('GETs /api/v1/topics with the page size and cursor, and returns the page', async () => {
			const spy = mockFetch({ status: 200, body: page, headers: TEST_RATE_LIMIT_HEADERS });
			const result = await createTestClient().topics.list({ limit: 10, cursor: 'a/b' });

			expect(result).toEqual(page);
			const [url, options] = spy.mock.calls[0];
			expect(new URL(String(url)).pathname).toBe('/api/v1/topics');
			expect(new URL(String(url)).search).toBe('?limit=10&cursor=a%2Fb');
			expect(options?.method).toBe('GET');
		});

		it('sends no query for the first page', async () => {
			const spy = mockFetch({ status: 200, body: page, headers: TEST_RATE_LIMIT_HEADERS });
			await createTestClient().topics.list();
			expect(new URL(String(spy.mock.calls[0][0])).search).toBe('');
		});

		it('throws ForbiddenError with missing_scope for a key without topics:read', async () => {
			mockFetch({
				status: 403,
				body: {
					error: {
						category: 'forbidden',
						message: 'This API key is missing the required scope: topics:read',
						data: { reason: 'missing_scope', scope: 'topics:read' },
					},
				},
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const error = await createTestClient()
				.topics.list()
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ForbiddenError);
			expect((error as ForbiddenError).reason).toBe('missing_scope');
		});
	});

	describe('addContact', () => {
		const addResponse = {
			success: true,
			contactId: 'c_123',
			topicId: 'topic_456',
			doiStatus: 'not_required' as const,
		};

		it('should POST to /api/v1/topics/{topicId}/contacts with email', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: addResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.topics.addContact({
				topicId: 'topic_456',
				email: 'user@example.com',
			});

			expect(result).toEqual(addResponse);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/topics/topic_456/contacts');
			expect(options?.method).toBe('POST');
			expect(JSON.parse(options?.body as string)).toEqual({ email: 'user@example.com' });
		});

		it('should POST with contactId', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: addResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.topics.addContact({
				topicId: 'topic_456',
				contactId: 'c_789',
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body).toEqual({ contactId: 'c_789' });
		});

		it('should throw ValidationError when neither email nor contactId provided', async () => {
			const client = createTestClient();

			await expect(client.topics.addContact({ topicId: 'topic_456' })).rejects.toThrow(
				ValidationError
			);

			await expect(client.topics.addContact({ topicId: 'topic_456' })).rejects.toMatchObject({
				code: 'invalid_input',
				message: 'Either email or contactId is required',
			});
		});
	});

	describe('removeContact', () => {
		const removeResponse = {
			success: true,
			removed: true,
		};

		it('should DELETE /api/v1/topics/{topicId}/contacts/{emailOrId}', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: removeResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.topics.removeContact({
				topicId: 'topic_456',
				emailOrId: 'c_123',
			});

			expect(result).toEqual(removeResponse);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/topics/topic_456/contacts/c_123');
			expect(options?.method).toBe('DELETE');
		});

		it('should URL-encode emailOrId', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: { success: true, removed: true } },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.topics.removeContact({
				topicId: 'topic_456',
				emailOrId: 'user@example.com',
			});

			const [url] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/topics/topic_456/contacts/user%40example.com');
		});
	});
});
