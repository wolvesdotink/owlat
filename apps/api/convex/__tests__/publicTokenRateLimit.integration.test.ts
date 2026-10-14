import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { rateLimiter } from '../lib/rateLimiter';
import { failureShardKey, MAX_TOKEN_LENGTH } from '../lib/publicTokenPolicy';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycle';

/**
 * Rate limits on the public capability-token routes (issue #1323), through the
 * real routes and the persistent limiter. The policy (lib/publicTokenPolicy.ts):
 *
 *   - a token gets a bucket of its own only after it is verified, keyed on the
 *     digest of its decoded form, so every spelling shares it;
 *   - a request that is never admitted spends only the bounded failure budget
 *     (an address shard plus one global key);
 *   - an empty failure budget never stops a real link, and never changes which
 *     bucket a real link is charged to.
 */

const modules = import.meta.glob('../**/*.*s');

const SHARE_TOKEN = 'sharetokenABC123';
const SHARE_LIMIT = 30; // subscriptionManagement: 30 per minute
const SHARD_CAPACITY = 60; // publicTokenFailure burst
const GLOBAL_CAPACITY = 1200; // publicTokenFailureGlobal burst
const ATTACKER = '203.0.113.44';

type T = ReturnType<typeof convexTest>;

function harness(): T {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function seedShare(t: T, token: string): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('shareLinks', {
			targetType: 'emailTemplate',
			token,
			htmlContent: '<p>Hello</p>',
			subject: 'Shared subject',
			expiresAt: now + 60 * 60 * 1000,
			createdBy: 'user_1',
			createdAt: now,
		});
	});
}

/**
 * Use up every failure budget the unresolved address can reach, in one step:
 * the global key, and the per-address key an earlier design used for it.
 */
async function drainGlobalFailures(t: T): Promise<void> {
	await t.run(async (ctx) => {
		await rateLimiter.limit(ctx, 'publicTokenFailureGlobal', {
			key: 'global',
			count: GLOBAL_CAPACITY,
		});
		await rateLimiter.limit(ctx, 'publicTokenFailure', { key: 'unknown', count: SHARD_CAPACITY });
	});
}

function fromIp(ip: string): RequestInit {
	return { headers: { 'X-Forwarded-For': ip } };
}

async function status(t: T, path: string, init?: RequestInit): Promise<number> {
	return (await t.fetch(path, init)).status;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('public token rate limits', () => {
	it('charges every encoded spelling of one token to the same bucket', async () => {
		const t = harness();
		await seedShare(t, SHARE_TOKEN);

		for (let i = 0; i < SHARE_LIMIT; i++) {
			expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(200);
		}
		expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(429);
		expect(await status(t, '/share/%73haretokenABC123')).toBe(429);
		expect(await status(t, '/share/sharetoken%41BC%31%323')).toBe(429);
	});

	// Finding 1: invented tokens must not share buckets with real links.
	it('keeps an untouched real link open once invented tokens use up the unknown budget', async () => {
		const t = harness();
		await seedShare(t, SHARE_TOKEN);
		await drainGlobalFailures(t);

		for (let i = 0; i < 20; i++) {
			expect(await status(t, `/share/invented-${i}`)).toBe(429);
		}
		for (let i = 0; i < SHARE_LIMIT; i++) {
			expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(200);
		}
		expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(429);
	});

	// Finding 2: the failure budget's state must not move a real link's counter.
	it('never hands a spent real link a fresh budget', async () => {
		const t = harness();
		await seedShare(t, SHARE_TOKEN);

		for (let i = 0; i < SHARE_LIMIT; i++) {
			expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(200);
		}
		expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(429);
		await drainGlobalFailures(t);
		expect(await status(t, `/share/${SHARE_TOKEN}`)).toBe(429);
	});

	// Finding 3: failures from one address must not block real links there.
	it('lets a real link through from an address whose failure budget is spent', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		const t = harness();
		await seedShare(t, SHARE_TOKEN);
		const attacker = fromIp(ATTACKER);

		for (let i = 0; i < SHARD_CAPACITY; i++) {
			expect(await status(t, `/share/invented-${i}`, attacker)).toBe(404);
		}
		expect(await status(t, '/share/invented-next', attacker)).toBe(429);
		expect(await status(t, `/share/${SHARE_TOKEN}`, attacker)).toBe(200);
		// Another address in another shard still gets the plain 404.
		expect(await status(t, '/share/invented-other', fromIp('198.51.100.7'))).toBe(404);
	});

	// Finding 4: an invented token gets no bucket of its own.
	it('creates no bucket for a token until it is real', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		const t = harness();
		const attacker = fromIp(ATTACKER);
		const token = 'latecomerToken42';

		for (let i = 0; i < 40; i++) {
			expect(await status(t, `/share/${token}`, attacker)).toBe(404);
		}
		// Had those 40 requests charged a bucket for this token, it would now
		// have none of its 30 left.
		await seedShare(t, token);
		for (let i = 0; i < SHARE_LIMIT; i++) {
			expect(await status(t, `/share/${token}`, attacker)).toBe(200);
		}
		expect(await status(t, `/share/${token}`, attacker)).toBe(429);
	});

	// Finding 5: a malformed form id is a typed not-found that spends the
	// failure budget, not a validator throw.
	it('answers a malformed form id with 404 and meters it as a failure', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		const t = harness();
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('instanceSettings', {
				featureFlags: { forms: true },
				createdAt: now,
				updatedAt: now,
			});
		});
		const post: RequestInit = {
			method: 'POST',
			headers: { 'X-Forwarded-For': ATTACKER, 'Content-Type': 'application/json' },
			body: '{}',
		};

		for (let i = 0; i < SHARD_CAPACITY; i++) {
			const response = await t.fetch(`/forms/not-an-id-${i}`, post);
			expect(response.status).toBe(404);
			const body = await response.json();
			expect(body.error.data.reason).toBe('form_not_found');
		}
		expect((await t.fetch('/forms/not-an-id-next', post)).status).toBe(429);
	});
});

// Finding 7: the client-API confirmation follows the same policy.
describe('form confirmation over the client API', () => {
	async function seedPendingContact(t: T, token: string): Promise<void> {
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('contacts', {
				email: 'pending@example.com',
				source: 'form',
				searchableText: 'pending@example.com',
				doiStatus: 'pending',
				doiConfirmationToken: token,
				doiTokenExpiresAt: now + DOI_TOKEN_TTL_MS,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	it('meters invented tokens on the bounded failure budget and still confirms a real one', async () => {
		const t = harness();
		await seedPendingContact(t, 'real-confirm-token');

		for (let i = 0; i < SHARD_CAPACITY; i++) {
			expect(
				await t.mutation(api.forms.endpoints.confirmSubmission, { token: `invented-${i}` })
			).toEqual({ success: false, error: 'invalid_token' });
		}
		await expect(
			t.mutation(api.forms.endpoints.confirmSubmission, { token: 'invented-next' })
		).rejects.toThrow(/Too many confirmation attempts/);

		const confirmed = await t.mutation(api.forms.endpoints.confirmSubmission, {
			token: 'real-confirm-token',
		});
		expect(confirmed.success).toBe(true);
	});

	it('refuses an over-long token on the landing-page query', async () => {
		const t = harness();
		const token = 'a'.repeat(MAX_TOKEN_LENGTH + 1);
		await seedPendingContact(t, token);
		expect(await t.query(api.forms.endpoints.getByConfirmationToken, { token })).toBeNull();
	});
});

describe('failure shard keys', () => {
	it('come from a fixed set, and the unresolved address has none', () => {
		const shards = new Set<string | null>();
		for (let i = 0; i < 20_000; i++) shards.add(failureShardKey(`10.${i >> 8}.${i & 255}.1`));
		expect(shards.size).toBeLessThanOrEqual(4096);
		expect(failureShardKey('unknown')).toBeNull();
	});
});
