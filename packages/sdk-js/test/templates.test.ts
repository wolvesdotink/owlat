import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATION_EXAMPLES } from '@owlat/public-contract/schemas';
import { createTestClient, mockFetch, TEST_RATE_LIMIT_HEADERS } from './helpers';
import { ConflictError, InvalidStateError, ValidationError } from '../src/errors';
import type { TransactionalEmail } from '../src';

afterEach(() => {
	vi.restoreAllMocks();
});

// Typed as a read returns it: the upserts below prove a read is accepted as a write.
const EMAIL: TransactionalEmail = OPERATION_EXAMPLES.getTransactionalEmail.response.data;

const headersOf = (init: RequestInit | undefined) =>
	(init?.headers ?? {}) as Record<string, string>;

describe('TransactionalEmailsResource', () => {
	it('sends the revision a write was built on as If-Match, and whilePublished in the query', async () => {
		const spy = mockFetch({
			status: 200,
			body: OPERATION_EXAMPLES.putTransactionalEmail.response,
			headers: TEST_RATE_LIMIT_HEADERS,
		});
		await createTestClient().transactionalEmails.upsert('order confirmation', EMAIL, {
			ifRevision: 4,
			whilePublished: true,
		});
		const [url, init] = spy.mock.calls[0]!;
		const sent = new URL(String(url));
		expect(sent.pathname).toBe('/api/v1/transactional-emails/order%20confirmation');
		expect(sent.searchParams.get('whilePublished')).toBe('true');
		expect(headersOf(init)['If-Match']).toBe('"4"');
	});

	it('sends no If-Match and no query without options', async () => {
		const spy = mockFetch({ status: 200, body: OPERATION_EXAMPLES.putTransactionalEmail.response });
		await createTestClient().transactionalEmails.upsert('order-confirmation', EMAIL);
		const [url, init] = spy.mock.calls[0]!;
		expect(new URL(String(url)).search).toBe('');
		expect(headersOf(init)['If-Match']).toBeUndefined();
	});

	it('sends If-Match on a publish built on a revision', async () => {
		const spy = mockFetch({
			status: 200,
			body: OPERATION_EXAMPLES.publishTransactionalEmail.response,
		});
		await createTestClient().transactionalEmails.publish('order-confirmation', { ifRevision: 7 });
		expect(headersOf(spy.mock.calls[0]![1])['If-Match']).toBe('"7"');
	});

	it('throws ConflictError with the current revision when the email moved on', async () => {
		mockFetch({
			status: 409,
			body: {
				error: {
					category: 'conflict',
					message: 'The email is at revision 5, not 4',
					data: { reason: 'revision_mismatch', currentRevision: 5 },
				},
			},
		});
		const error = await createTestClient()
			.transactionalEmails.upsert('order-confirmation', EMAIL, { ifRevision: 4 })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect((error as ConflictError).data).toMatchObject({ currentRevision: 5 });
	});

	it('throws ValidationError naming the block on invalid content', async () => {
		mockFetch({
			status: 400,
			body: {
				error: {
					category: 'invalid_input',
					message: 'Block b-button: Button block has no valid URL',
					data: {
						reason: 'invalid_content',
						field: 'blocks',
						blockId: 'b-button',
						issues: [
							{
								severity: 'error',
								code: 'BUTTON_NO_URL',
								message: 'Button block has no valid URL',
								blockId: 'b-button',
								blockType: 'button',
							},
						],
					},
				},
			},
		});
		const error = await createTestClient()
			.transactionalEmails.create({ ...EMAIL, slug: 'order-confirmation' })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).data).toMatchObject({ blockId: 'b-button' });
	});

	it('throws InvalidStateError when a published email is changed without whilePublished', async () => {
		mockFetch({
			status: 422,
			body: {
				error: {
					category: 'invalid_state',
					message: 'The email is published.',
					data: { reason: 'email_published' },
				},
			},
		});
		await expect(
			createTestClient().transactionalEmails.upsert('order-confirmation', EMAIL)
		).rejects.toBeInstanceOf(InvalidStateError);
	});
});
