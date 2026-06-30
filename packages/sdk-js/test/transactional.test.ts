import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';
import { ValidationError } from '../src/errors';
import type { TransactionalAttachment } from '../src/types/transactional';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('TransactionalResource', () => {
	const sendResponse = {
		status: 'queued' as const,
		email: 'user@example.com',
		transactionalEmailId: 'te_123',
		slug: 'welcome',
		contactCreated: false,
		language: 'en',
	};

	describe('send', () => {
		it('should POST to /api/v1/transactional with slug', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: sendResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			const result = await client.transactional.send({
				email: 'user@example.com',
				slug: 'welcome',
			});

			expect(result).toEqual(sendResponse);
			const [url, options] = spy.mock.calls[0];
			expect(url).toContain('/api/v1/transactional');
			expect(options?.method).toBe('POST');
			expect(JSON.parse(options?.body as string)).toEqual({
				email: 'user@example.com',
				slug: 'welcome',
			});
		});

		it('should POST to /api/v1/transactional with transactionalId', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: sendResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.transactional.send({
				email: 'user@example.com',
				transactionalId: 'te_123',
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body.transactionalId).toBe('te_123');
			expect(body.slug).toBeUndefined();
		});

		it('should throw ValidationError when neither slug nor transactionalId provided', async () => {
			const client = createTestClient();

			await expect(
				client.transactional.send({ email: 'user@example.com' })
			).rejects.toThrow(ValidationError);

			await expect(
				client.transactional.send({ email: 'user@example.com' })
			).rejects.toMatchObject({
				code: 'invalid_input',
				message: 'Either transactionalId or slug is required',
			});
		});

		it('should send attachments with base64 content', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: sendResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.transactional.send({
				email: 'user@example.com',
				slug: 'welcome',
				attachments: [
					{ filename: 'invoice.pdf', content: 'base64data', contentType: 'application/pdf' },
				],
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body.attachments).toEqual([
				{ filename: 'invoice.pdf', content: 'base64data', contentType: 'application/pdf' },
			]);
		});

		it('should send attachments with URL', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: sendResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.transactional.send({
				email: 'user@example.com',
				slug: 'welcome',
				attachments: [
					{ filename: 'report.pdf', url: 'https://example.com/report.pdf' },
				],
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body.attachments).toEqual([
				{ filename: 'report.pdf', url: 'https://example.com/report.pdf' },
			]);
		});

		it('should throw ValidationError when attachment has neither content nor url', async () => {
			const client = createTestClient();

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments: [{ filename: 'file.txt' }],
				})
			).rejects.toThrow(ValidationError);

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments: [{ filename: 'file.txt' }],
				})
			).rejects.toMatchObject({
				code: 'invalid_input',
				message: 'Attachment must have either content or url',
			});
		});

		it('should throw ValidationError when attachment has both content and url', async () => {
			const client = createTestClient();

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments: [
						{ filename: 'file.txt', content: 'data', url: 'https://example.com/file.txt' },
					],
				})
			).rejects.toThrow(ValidationError);

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments: [
						{ filename: 'file.txt', content: 'data', url: 'https://example.com/file.txt' },
					],
				})
			).rejects.toMatchObject({
				code: 'invalid_input',
				message: 'Attachment must have either content or url, not both',
			});
		});

		it('should throw ValidationError when attachment missing filename', async () => {
			const client = createTestClient();

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments: [{ content: 'data' } as TransactionalAttachment],
				})
			).rejects.toThrow(ValidationError);

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments: [{ content: 'data' } as TransactionalAttachment],
				})
			).rejects.toMatchObject({
				code: 'invalid_input',
				message: 'Each attachment must have a filename',
			});
		});

		it('should throw ValidationError when more than 10 attachments', async () => {
			const client = createTestClient();

			const attachments = Array.from({ length: 11 }, (_, i) => ({
				filename: `file${i}.txt`,
				content: 'data',
			}));

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments,
				})
			).rejects.toThrow(ValidationError);

			await expect(
				client.transactional.send({
					email: 'user@example.com',
					slug: 'welcome',
					attachments,
				})
			).rejects.toMatchObject({
				code: 'invalid_input',
				message: 'Maximum 10 attachments allowed',
			});
		});

		it('should pass dataVariables and language', async () => {
			const spy = mockFetch({
				status: 200,
				body: { data: sendResponse },
				headers: TEST_RATE_LIMIT_HEADERS,
			});
			const client = createTestClient();

			await client.transactional.send({
				email: 'user@example.com',
				slug: 'welcome',
				dataVariables: { userName: 'John', orderId: '123' },
				language: 'de',
			});

			const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
			expect(body.dataVariables).toEqual({ userName: 'John', orderId: '123' });
			expect(body.language).toBe('de');
		});
	});
});
