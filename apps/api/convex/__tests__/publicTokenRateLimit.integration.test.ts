import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';

/**
 * Rate limits on the per-recipient token endpoints (`rateLimitKeyMode:
 * 'ip+token'`), through the real `/share/:token` route and the persistent
 * limiter (issue #1323):
 *
 *   - every percent-encoded spelling of a live token spends the same bucket;
 *   - invented tokens are capped by the caller's per-IP failure budget, after
 *     which no further per-token bucket or lookup is made for that address;
 *   - with no trusted proxy, invented tokens land in a fixed set of overflow
 *     buckets, so a valid link still opens.
 */

const modules = import.meta.glob('../**/*.*s');

const SHARE_TOKEN = 'sharetokenABC123';
const SHARE_LIMIT = 30; // subscriptionManagement: 30 per minute
const FAILURE_CAPACITY = 60; // publicTokenFailure burst

async function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('shareLinks', {
			targetType: 'emailTemplate',
			token: SHARE_TOKEN,
			htmlContent: '<p>Hello</p>',
			subject: 'Shared subject',
			expiresAt: now + 60 * 60 * 1000,
			createdBy: 'user_1',
			createdAt: now,
		});
	});
	return t;
}

function fromIp(ip: string): RequestInit {
	return { headers: { 'X-Forwarded-For': ip } };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('public token endpoint rate limits', () => {
	it('charges every encoded spelling of one token to the same bucket', async () => {
		const t = await setup();

		for (let i = 0; i < SHARE_LIMIT; i++) {
			const response = await t.fetch(`/share/${SHARE_TOKEN}`);
			expect(response.status).toBe(200);
		}
		expect((await t.fetch(`/share/${SHARE_TOKEN}`)).status).toBe(429);
		expect((await t.fetch('/share/%73haretokenABC123')).status).toBe(429);
		expect((await t.fetch('/share/sharetoken%41BC%31%323')).status).toBe(429);
	});

	it('caps invented tokens at the per-IP failure budget', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		const t = await setup();
		const attacker = fromIp('203.0.113.44');

		for (let i = 0; i < FAILURE_CAPACITY; i++) {
			const response = await t.fetch(`/share/invented-${i}`, attacker);
			expect(response.status).toBe(404);
		}
		// The budget is spent: the next invented token is refused before a bucket
		// is created for it or the share link is looked up.
		expect((await t.fetch('/share/invented-next', attacker)).status).toBe(429);

		// Another address is unaffected and the valid link still opens there.
		const other = fromIp('198.51.100.7');
		expect((await t.fetch('/share/invented-other', other)).status).toBe(404);
		expect((await t.fetch(`/share/${SHARE_TOKEN}`, other)).status).toBe(200);
	});

	it('keeps valid links working on the shared unknown address', async () => {
		const t = await setup();

		for (let i = 0; i < FAILURE_CAPACITY; i++) {
			expect((await t.fetch(`/share/invented-${i}`)).status).toBe(404);
		}
		// With no trusted proxy every caller is 'unknown'; refusing here would
		// lock every recipient out, so the valid link still opens.
		expect((await t.fetch(`/share/${SHARE_TOKEN}`)).status).toBe(200);
	});

	it('maps invented tokens on the unknown address to a fixed set of overflow buckets', async () => {
		const t = await setup();
		// Spend the shared failure budget.
		for (let i = 0; i < FAILURE_CAPACITY; i++) {
			await t.mutation(internal.lib.publicRateLimit.checkPublicRateLimit, {
				limitType: 'publicTokenFailure',
				key: 'unknown',
			});
		}

		const gate = (tokenDigest: string) =>
			t.mutation(internal.lib.publicRateLimit.checkPublicTokenRateLimit, {
				limitType: 'subscriptionManagement',
				ip: 'unknown',
				tokenDigest,
			});

		// Distinct digests that share a two-hex-digit prefix share one bucket.
		for (let i = 0; i < SHARE_LIMIT; i++) {
			expect((await gate(`aa${i.toString(16).padStart(62, '0')}`)).ok).toBe(true);
		}
		expect((await gate(`aa${'f'.repeat(62)}`)).ok).toBe(false);
		expect((await gate(`bb${'f'.repeat(62)}`)).ok).toBe(true);
	});
});
