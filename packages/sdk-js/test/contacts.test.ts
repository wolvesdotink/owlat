import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ContactsResource', () => {
	describe('create', () => {
		it('should POST to /api/v1/contacts with body', async () => {
			const contactData = {
				id: 'c_123',
				email: 'user@example.com',
				firstName: 'John',
				lastName: 'Doe',
				source: 'api' as const,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
			};
			const spy = mockFetch({
				status: 200,
				body: { data: contactData },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.contacts.create({
				email: 'user@example.com',
				firstName: 'John',
				lastName: 'Doe',
			});

			expect(result).toEqual(contactData);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/contacts');
			expect(options?.method).toBe('POST');
			expect(JSON.parse(options?.body as string)).toEqual({
				email: 'user@example.com',
				firstName: 'John',
				lastName: 'Doe',
			});
		});
	});

	describe('get', () => {
		it('should GET /api/v1/contacts/{id}', async () => {
			const contactData = {
				id: 'c_123',
				email: 'user@example.com',
				firstName: null,
				lastName: null,
				source: 'api' as const,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-01T00:00:00Z',
			};
			const spy = mockFetch({
				status: 200,
				body: { data: contactData },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.contacts.get('c_123');

			expect(result).toEqual(contactData);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/contacts/c_123');
			expect(options?.method).toBe('GET');
		});

		it('should URL-encode email addresses', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: { id: 'c_1', email: 'user@example.com' } },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.contacts.get('user@example.com');

			const [url] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/contacts/user%40example.com');
		});
	});

	describe('update', () => {
		it('should PUT to /api/v1/contacts/{id} with body', async () => {
			const updated = {
				id: 'c_123',
				email: 'user@example.com',
				firstName: 'Jane',
				lastName: null,
				source: 'api' as const,
				createdAt: '2024-01-01T00:00:00Z',
				updatedAt: '2024-01-02T00:00:00Z',
			};
			const spy = mockFetch({
				status: 200,
				body: { data: updated },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.contacts.update('c_123', { firstName: 'Jane' });

			expect(result).toEqual(updated);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/contacts/c_123');
			expect(options?.method).toBe('PUT');
			expect(JSON.parse(options?.body as string)).toEqual({ firstName: 'Jane' });
		});

		it('should URL-encode email in path', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: { id: 'c_1' } },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.contacts.update('user@example.com', { firstName: 'X' });

			const [url] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/contacts/user%40example.com');
		});
	});

	describe('delete', () => {
		it('should DELETE /api/v1/contacts/{id}', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: { id: 'c_123', deleted: true } },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.contacts.delete('c_123');

			expect(result).toEqual({ id: 'c_123', deleted: true });
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/contacts/c_123');
			expect(options?.method).toBe('DELETE');
		});
	});

	describe('list', () => {
		const paginatedResponse = {
			data: [{ id: 'c_1', email: 'a@b.com' }],
			pagination: { limit: 25, totalItems: 1, cursor: null, isDone: true },
		};

		it('should GET /api/v1/contacts with no query params when none provided', async () => {
			const spy = mockFetch({
				status: 200,
				body: paginatedResponse,
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.contacts.list();

			expect(result).toEqual(paginatedResponse);
			const [url] = spy.mock.calls[0];
			expect(url).toMatch(/\/api\/v1\/contacts$/);
		});

		it('should build correct query string with all params', async () => {
			const spy = mockFetch({
				status: 200,
				body: paginatedResponse,
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.contacts.list({
				limit: 10,
				cursor: 'opaque_cursor_abc',
				search: 'john',
			});

			const [url] = spy.mock.calls[0];
			expect(url).toContain('limit=10');
			expect(url).toContain('cursor=opaque_cursor_abc');
			expect(url).toContain('search=john');
		});

		it('should only include provided params in query string', async () => {
			const spy = mockFetch({
				status: 200,
				body: paginatedResponse,
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.contacts.list({ limit: 50 });

			const [url] = spy.mock.calls[0];
			expect(url).toContain('limit=50');
			expect(url).not.toContain('cursor=');
			expect(url).not.toContain('search=');
		});
	});

	describe('listAll', () => {
		it('should follow cursors across pages until isDone', async () => {
			const page1 = {
				data: [{ id: 'c_1', email: 'a@b.com' }, { id: 'c_2', email: 'b@b.com' }],
				pagination: { limit: 2, totalItems: 3, cursor: 'cursor_page2', isDone: false },
			};
			const page2 = {
				data: [{ id: 'c_3', email: 'c@b.com' }],
				pagination: { limit: 2, totalItems: 3, cursor: null, isDone: true },
			};
			const spy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(JSON.stringify(page1), { status: 200, headers: TEST_RATE_LIMIT_HEADERS })
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(page2), { status: 200, headers: TEST_RATE_LIMIT_HEADERS })
				);
			const client = createTestClient();

			const collected: string[] = [];
			for await (const contact of client.contacts.listAll({ limit: 2 })) {
				collected.push(contact.id);
			}

			expect(collected).toEqual(['c_1', 'c_2', 'c_3']);
			expect(spy).toHaveBeenCalledTimes(2);
			// First request has no cursor; second carries the page-1 cursor.
			const [firstUrl] = spy.mock.calls[0];
			const [secondUrl] = spy.mock.calls[1];
			expect(firstUrl).not.toContain('cursor=');
			expect(secondUrl).toContain('cursor=cursor_page2');
		});

		it('should stop after a single page when isDone is true immediately', async () => {
			const spy = mockFetch({
				status: 200,
				body: {
					data: [{ id: 'c_1', email: 'a@b.com' }],
					pagination: { limit: 25, totalItems: 1, cursor: null, isDone: true },
				},
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const collected: string[] = [];
			for await (const contact of client.contacts.listAll()) {
				collected.push(contact.id);
			}

			expect(collected).toEqual(['c_1']);
			expect(spy).toHaveBeenCalledTimes(1);
		});
	});
});
