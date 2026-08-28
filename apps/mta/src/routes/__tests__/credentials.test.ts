/**
 * Credential management routes — the H2 allowedDomains backfill surface.
 *
 * Covers the PATCH `/:apiKey` primitive (master-key auth, input validation,
 * normalization, blob preservation) and the `?includeKeys=1` full-key list the
 * backfill migration reads to address each PATCH. We drive the real Hono app over
 * an ioredis-mock so every gate runs end to end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

import { createCredentialRoutes } from '../credentials.js';
import { createCredential, lookupCredential } from '../../auth/credentials.js';
import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as unknown as MtaConfig;

function authedRequest(
	app: ReturnType<typeof createCredentialRoutes>,
	method: string,
	path: string,
	body?: unknown
): Promise<Response> {
	return app.request(path, {
		method,
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe('credential routes (H2 allowedDomains)', () => {
	let redis: RealRedis;
	let app: ReturnType<typeof createCredentialRoutes>;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		app = createCredentialRoutes(redis, config);
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('PATCH /:apiKey', () => {
		it('rewrites allowedDomains (normalized) preserving the rest of the blob', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Legacy');

			const res = await authedRequest(app, 'PATCH', `/${apiKey}`, {
				allowedDomains: ['Brand.com', ' brand.net ', 'BRAND.COM'],
			});
			expect(res.status).toBe(200);

			const cred = await lookupCredential(redis, apiKey);
			expect(cred!.allowedDomains).toEqual(['brand.com', 'brand.net']);
			expect(cred!.organizationId).toBe('org-1');
			expect(cred!.name).toBe('Legacy');
		});

		it('requires the master key', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Legacy');
			const res = await app.request(`/${apiKey}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ allowedDomains: ['brand.com'] }),
			});
			expect(res.status).toBe(401);
			// The blob is untouched.
			const cred = await lookupCredential(redis, apiKey);
			expect(cred!.allowedDomains).toBeUndefined();
		});

		it('404s an unknown credential', async () => {
			const res = await authedRequest(app, 'PATCH', '/owlat_missing', {
				allowedDomains: ['brand.com'],
			});
			expect(res.status).toBe(404);
		});

		it('400s a non-array allowedDomains', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Legacy');
			const res = await authedRequest(app, 'PATCH', `/${apiKey}`, { allowedDomains: 'brand.com' });
			expect(res.status).toBe(400);
		});

		it('400s a body with non-string array entries', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Legacy');
			const res = await authedRequest(app, 'PATCH', `/${apiKey}`, {
				allowedDomains: ['ok.com', 42],
			});
			expect(res.status).toBe(400);
		});

		it('accepts an explicit empty set (fail-closed: authorizes no domain)', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Scoped', ['brand.com']);
			const res = await authedRequest(app, 'PATCH', `/${apiKey}`, { allowedDomains: [] });
			expect(res.status).toBe(200);
			const cred = await lookupCredential(redis, apiKey);
			expect(cred!.allowedDomains).toEqual([]);
		});
	});

	describe('GET /?organizationId&includeKeys=1', () => {
		it('returns FULL keys with includeKeys=1', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'A');
			const res = await authedRequest(app, 'GET', '/?organizationId=org-1&includeKeys=1');
			expect(res.status).toBe(200);
			const json = (await res.json()) as { credentials: Array<{ apiKey: string }> };
			expect(json.credentials).toHaveLength(1);
			expect(json.credentials[0]!.apiKey).toBe(apiKey);
			expect(json.credentials[0]!.apiKey).not.toContain('...');
		});

		it('redacts keys by default (no includeKeys)', async () => {
			await createCredential(redis, 'org-1', 'A');
			const res = await authedRequest(app, 'GET', '/?organizationId=org-1');
			expect(res.status).toBe(200);
			const json = (await res.json()) as { credentials: Array<{ apiKey: string }> };
			expect(json.credentials[0]!.apiKey).toContain('...');
		});

		it('requires the master key', async () => {
			const res = await app.request('/?organizationId=org-1&includeKeys=1', { method: 'GET' });
			expect(res.status).toBe(401);
		});
	});
});
