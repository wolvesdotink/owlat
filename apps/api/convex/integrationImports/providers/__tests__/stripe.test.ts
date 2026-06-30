/**
 * Stripe **Integration import provider adapter** — unit tests.
 *
 * Stubs `global.fetch`. Exercises:
 *   - `validateConfig` accepts `sk_*` and `rk_*` keys; rejects empty or
 *     mis-prefixed keys.
 *   - `fetchPage` normalizes `data[]` into `ImportRow[]` (lowercase email,
 *     `name` split into firstName/lastName, `metadata.first_name`
 *     overrides, remaining metadata → `properties`).
 *   - HTTP 429 → `RetryableProviderError`.
 *   - Non-OK with JSON `error.message` → `Error` with extracted message.
 *   - Non-OK with non-JSON body → `Error` with status-only message.
 *   - `has_more: false` → `nextCursor: null`; `has_more: true` →
 *     `nextCursor` is the last customer id.
 *
 * Per ADR-0027.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { stripeProvider } from '../stripe';
import { RetryableProviderError } from '../../_common';

describe('stripeProvider', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('exposes the expected discriminator + DOI attest', () => {
		expect(stripeProvider.kind).toBe('stripe');
		expect(stripeProvider.defaultDoiAttest).toBe('stripe');
	});

	describe('validateConfig', () => {
		it('accepts sk_ prefixed key', () => {
			expect(stripeProvider.validateConfig({ provider: 'stripe', apiKey: 'sk_live_xxx' }))
				.toEqual({ ok: true });
		});

		it('accepts rk_ prefixed key (restricted)', () => {
			expect(stripeProvider.validateConfig({ provider: 'stripe', apiKey: 'rk_live_xxx' }))
				.toEqual({ ok: true });
		});

		it('rejects empty apiKey', () => {
			const res = stripeProvider.validateConfig({ provider: 'stripe', apiKey: '' });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toMatch(/required/);
		});

		it('rejects key with wrong prefix', () => {
			const res = stripeProvider.validateConfig({
				provider: 'stripe',
				apiKey: 'pk_test_xxx',
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toMatch(/sk_|rk_/);
		});
	});

	describe('fetchPage', () => {
		const baseConfig = { provider: 'stripe' as const, apiKey: 'sk_test_xxx' };

		it('normalizes customers with name split into first/last', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: 'cus_001',
								email: 'Alice@example.com',
								name: 'Alice Smith Doe',
								metadata: { COMPANY: 'Acme' },
							},
						],
						has_more: false,
					}),
					{ status: 200 },
				),
			);

			const result = await stripeProvider.fetchPage({ config: baseConfig, cursor: '' });

			expect(result.rows).toEqual([
				{
					email: 'alice@example.com',
					firstName: 'Alice',
					lastName: 'Smith Doe',
					properties: { COMPANY: 'Acme' },
				},
			]);
			expect(result.nextCursor).toBe(null);
			expect(result.totalEstimate).toBeUndefined();
		});

		it('drops customers without email', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{ id: 'cus_001', email: null, name: 'No Email', metadata: {} },
							{ id: 'cus_002', email: 'has@email.com', name: 'Has Email' },
						],
						has_more: false,
					}),
					{ status: 200 },
				),
			);

			const result = await stripeProvider.fetchPage({ config: baseConfig, cursor: '' });

			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]!.email).toBe('has@email.com');
		});

		it('metadata first_name / last_name overrides name-split', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: 'cus_001',
								email: 'a@example.com',
								name: 'Alice Doe',
								metadata: { first_name: 'AliceOverride', last_name: 'DoeOverride' },
							},
						],
						has_more: false,
					}),
					{ status: 200 },
				),
			);

			const result = await stripeProvider.fetchPage({ config: baseConfig, cursor: '' });
			expect(result.rows[0]!.firstName).toBe('AliceOverride');
			expect(result.rows[0]!.lastName).toBe('DoeOverride');
			// Name fields excluded from properties.
			expect(result.rows[0]!.properties).toBeUndefined();
		});

		it('returns nextCursor when has_more is true', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ id: 'cus_last', email: 'l@example.com', name: null }],
						has_more: true,
					}),
					{ status: 200 },
				),
			);

			const result = await stripeProvider.fetchPage({ config: baseConfig, cursor: '' });
			expect(result.nextCursor).toBe('cus_last');
		});

		it('throws RetryableProviderError on 429', async () => {
			global.fetch = vi
				.fn()
				.mockResolvedValue(new Response('Too many', { status: 429 }));

			await expect(
				stripeProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toBeInstanceOf(RetryableProviderError);
		});

		it('throws Error with extracted error.message on JSON error body', async () => {
			global.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: { message: 'API key invalid' } }), {
					status: 401,
				}),
			);

			await expect(
				stripeProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toThrow('API key invalid');
		});

		it('throws Error with status-only message on non-JSON error body', async () => {
			global.fetch = vi
				.fn()
				.mockResolvedValue(new Response('Internal error', { status: 500 }));

			await expect(
				stripeProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toThrow('Stripe API error: 500');
		});

		it('wraps fetch throw as RetryableProviderError', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

			await expect(
				stripeProvider.fetchPage({ config: baseConfig, cursor: '' }),
			).rejects.toBeInstanceOf(RetryableProviderError);
		});

		it('appends starting_after only when cursor is non-empty', async () => {
			// Fresh Response per call — Response bodies are single-read.
			const fetchSpy = vi.fn().mockImplementation(
				() =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchSpy;

			await stripeProvider.fetchPage({ config: baseConfig, cursor: '' });
			expect(fetchSpy.mock.calls[0]![0]).not.toContain('starting_after');

			await stripeProvider.fetchPage({ config: baseConfig, cursor: 'cus_abc' });
			expect(fetchSpy.mock.calls[1]![0]).toContain('starting_after=cus_abc');
		});
	});
});
