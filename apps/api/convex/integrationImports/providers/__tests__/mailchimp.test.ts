/**
 * Mailchimp **Integration import provider adapter** — unit tests.
 *
 * Stubs `global.fetch` so the test runs without network. Exercises:
 *   - `validateConfig` accepts well-formed keys; rejects malformed
 *     datacenter, empty listId, empty apiKey.
 *   - `fetchPage` normalizes `members[]` into `ImportRow[]` (lowercase
 *     email, `merge_fields.FNAME`/`LNAME` → `firstName`/`lastName`,
 *     remaining merge fields → `properties`).
 *   - HTTP 429 → `RetryableProviderError`.
 *   - Non-OK with JSON body → `Error` with extracted `detail` / `title`.
 *   - Non-OK with non-JSON body → `Error` with status-only message.
 *   - Terminal page (response smaller than `PAGE_SIZE`) → `nextCursor:
 *     null`. Full page → `nextCursor` advances by `PAGE_SIZE`.
 *
 * Per ADR-0027.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mailchimpProvider } from '../mailchimp';
import { RetryableProviderError } from '../../_common';

describe('mailchimpProvider', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('exposes the expected discriminator + DOI attest', () => {
		expect(mailchimpProvider.kind).toBe('mailchimp');
		expect(mailchimpProvider.defaultDoiAttest).toBe('mailchimp');
	});

	describe('validateConfig', () => {
		it('accepts well-formed apiKey-datacenter shape', () => {
			expect(
				mailchimpProvider.validateConfig({
					provider: 'mailchimp',
					apiKey: 'abc123-us21',
					listId: 'list_a',
				}),
			).toEqual({ ok: true });
		});

		it('rejects apiKey missing datacenter suffix', () => {
			const res = mailchimpProvider.validateConfig({
				provider: 'mailchimp',
				apiKey: 'abc123',
				listId: 'list_a',
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toMatch(/Invalid Mailchimp API key format/);
		});

		it('rejects apiKey with malformed datacenter (no digits)', () => {
			const res = mailchimpProvider.validateConfig({
				provider: 'mailchimp',
				apiKey: 'abc123-usone',
				listId: 'list_a',
			});
			expect(res.ok).toBe(false);
		});

		it('rejects empty listId', () => {
			const res = mailchimpProvider.validateConfig({
				provider: 'mailchimp',
				apiKey: 'abc-us21',
				listId: '',
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toMatch(/listId/);
		});
	});

	describe('fetchPage', () => {
		const baseConfig = {
			provider: 'mailchimp' as const,
			apiKey: 'abc123-us21',
			listId: 'list_a',
		};

		it('normalizes subscribed members and skips unsubscribed', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						members: [
							{
								email_address: 'Alice@example.com',
								status: 'subscribed',
								merge_fields: { FNAME: 'Alice', LNAME: 'Doe', COMPANY: 'Acme' },
							},
							{
								email_address: 'bob@example.com',
								status: 'unsubscribed',
								merge_fields: { FNAME: 'Bob' },
							},
						],
						total_items: 1,
					}),
					{ status: 200 },
				),
			);

			const result = await mailchimpProvider.fetchPage({
				config: baseConfig,
				cursor: '',
			});

			expect(result.rows).toEqual([
				{
					email: 'alice@example.com',
					firstName: 'Alice',
					lastName: 'Doe',
					properties: { COMPANY: 'Acme' },
				},
			]);
			expect(result.totalEstimate).toBe(1);
			expect(result.nextCursor).toBe(null);
		});

		it('drops empty merge_field values from properties', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						members: [
							{
								email_address: 'x@example.com',
								status: 'subscribed',
								merge_fields: { FNAME: 'X', COMPANY: '', PHONE: undefined },
							},
						],
						total_items: 1,
					}),
					{ status: 200 },
				),
			);

			const result = await mailchimpProvider.fetchPage({
				config: baseConfig,
				cursor: '',
			});

			// COMPANY ('') and PHONE (undefined) excluded; row has no properties.
			expect(result.rows[0]).toEqual({
				email: 'x@example.com',
				firstName: 'X',
				lastName: undefined,
			});
		});

		it('returns nextCursor on full page', async () => {
			const members = Array.from({ length: 100 }, (_, i) => ({
				email_address: `u${i}@example.com`,
				status: 'subscribed',
				merge_fields: {},
			}));
			global.fetch = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ members, total_items: 250 }), { status: 200 }),
				);

			const result = await mailchimpProvider.fetchPage({
				config: baseConfig,
				cursor: '0',
			});

			expect(result.rows).toHaveLength(100);
			expect(result.nextCursor).toBe('100');
			expect(result.totalEstimate).toBe(250);
		});

		it('throws RetryableProviderError on 429', async () => {
			global.fetch = vi
				.fn()
				.mockResolvedValue(new Response('Too many requests', { status: 429 }));

			await expect(
				mailchimpProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toBeInstanceOf(RetryableProviderError);
		});

		it('throws Error with extracted "detail" on JSON error body', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ detail: 'API Key Invalid', title: 'unused' }), {
					status: 401,
				}),
			);

			await expect(
				mailchimpProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toThrow('API Key Invalid');
		});

		it('throws Error with extracted "title" when detail missing', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ title: 'Not Found' }), {
					status: 404,
				}),
			);

			await expect(
				mailchimpProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toThrow('Not Found');
		});

		it('throws Error with status-only message on non-JSON error body', async () => {
			global.fetch = vi
				.fn()
				.mockResolvedValue(new Response('Internal error', { status: 500 }));

			await expect(
				mailchimpProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toThrow('Mailchimp API error: 500');
		});

		it('wraps fetch throw as RetryableProviderError', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

			await expect(
				mailchimpProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toBeInstanceOf(RetryableProviderError);
		});

		it('parses cursor "" as offset 0 and non-empty cursor as numeric offset', async () => {
			// Fresh Response per call — Response bodies are single-read.
			const fetchSpy = vi.fn().mockImplementation(
				() =>
					new Response(JSON.stringify({ members: [], total_items: 0 }), {
						status: 200,
					}),
			);
			global.fetch = fetchSpy;

			await mailchimpProvider.fetchPage({ config: baseConfig, cursor: '' });
			expect(fetchSpy.mock.calls[0]![0]).toContain('offset=0');

			await mailchimpProvider.fetchPage({ config: baseConfig, cursor: '300' });
			expect(fetchSpy.mock.calls[1]![0]).toContain('offset=300');
		});
	});
});
