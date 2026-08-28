import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';

/**
 * Per-IP throttle on FAILED API-key authentication (L3).
 *
 * A wrong/expired/unknown key never reaches the per-key `apiRequest` bucket
 * (there is no key to key it on), so without a coarse per-IP failure throttle an
 * attacker can probe key hashes against the store unbounded. The throttle:
 *   - trips to `rate_limited` after enough failures from one IP;
 *   - is isolated per IP (a fresh IP still gets the normal `invalid_key`);
 *   - never fires for a VALID key — a successful lookup spends no failure token.
 */

const modules = import.meta.glob('../**/*.*s');

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const ATTACKER_IP = '203.0.113.44';

describe('validateAndCheckRateLimit failure throttle (L3)', () => {
	it('meters failed key lookups per IP and eventually returns rate_limited', async () => {
		const t = setup();

		let tripped = false;
		for (let i = 0; i < 60; i++) {
			const r = await t.mutation(internal.auth.apiAuth.validateAndCheckRateLimit, {
				keyHash: 'no-such-key-hash',
				ip: ATTACKER_IP,
			});
			expect(r.success).toBe(false);
			if (!r.success && r.error === 'rate_limited') {
				tripped = true;
				break;
			}
			// Until the bucket drains, a bad key is a plain invalid_key.
			if (!r.success) expect(r.error).toBe('invalid_key');
		}
		expect(tripped).toBe(true);
	});

	it('isolates the throttle per IP — a fresh IP is not pre-throttled', async () => {
		const t = setup();

		// Drain the attacker IP's bucket.
		for (let i = 0; i < 60; i++) {
			const r = await t.mutation(internal.auth.apiAuth.validateAndCheckRateLimit, {
				keyHash: 'no-such-key-hash',
				ip: ATTACKER_IP,
			});
			if (!r.success && r.error === 'rate_limited') break;
		}

		const other = await t.mutation(internal.auth.apiAuth.validateAndCheckRateLimit, {
			keyHash: 'no-such-key-hash',
			ip: '198.51.100.7',
		});
		expect(other).toMatchObject({ success: false, error: 'invalid_key' });
	});

	it('never throttles a VALID key, even from an IP whose failure bucket is drained', async () => {
		const t = setup();

		await t.run(async (ctx) => {
			await ctx.db.insert('apiKeys', {
				name: 'Valid Key',
				keyHash: 'valid-key-hash',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Drain the attacker IP's failure bucket with bad keys.
		for (let i = 0; i < 60; i++) {
			const r = await t.mutation(internal.auth.apiAuth.validateAndCheckRateLimit, {
				keyHash: 'no-such-key-hash',
				ip: ATTACKER_IP,
			});
			if (!r.success && r.error === 'rate_limited') break;
		}

		// The valid key still authenticates from the very same IP: a successful
		// lookup never consults the failure bucket.
		const ok = await t.mutation(internal.auth.apiAuth.validateAndCheckRateLimit, {
			keyHash: 'valid-key-hash',
			ip: ATTACKER_IP,
		});
		expect(ok).toMatchObject({ success: true });
	});
});
