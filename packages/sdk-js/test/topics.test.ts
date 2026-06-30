import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';
import { ValidationError } from '../src/errors';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('TopicsResource', () => {
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

			await expect(
				client.topics.addContact({ topicId: 'topic_456' })
			).rejects.toThrow(ValidationError);

			await expect(
				client.topics.addContact({ topicId: 'topic_456' })
			).rejects.toMatchObject({
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
