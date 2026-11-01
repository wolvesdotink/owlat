/**
 * mail.ai.gate.assertAiAllowed — the spend-gate run before every Postbox LLM
 * call. Enforces the `ai` feature flag and the rate limit: a session user's
 * interactive bucket, or, for session-less (scheduled) work, the named
 * owner's `postboxAiBackground` bucket.
 */
import { convexTest } from 'convex-test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';
import { MISSING_AI_OWNER_MESSAGE, rateLimitRefusalOf } from '../mail/ai/gate';

/** The session the gate sees; null is a scheduled function (no auth). */
const auth = vi.hoisted(() => ({ session: null as null | { userId: string } }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () =>
			auth.session ? { ...auth.session, role: 'owner', activeOrganizationId: 'test-org' } : null
		),
	};
});

beforeEach(() => {
	auth.session = { userId: 'test-user' };
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

async function setAiFlag(t: ReturnType<typeof convexTest>, on: boolean) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { ai: on },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('mail.ai.gate.assertAiAllowed', () => {
	it('throws when the ai feature flag is off', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, false);
		await expect(t.mutation(internal.mail.ai.gate.assertAiAllowed, {})).rejects.toThrow(
			/disabled|forbidden/i
		);
	});

	it('allows calls while the ai flag is on, then rate-limits once the bucket drains', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);

		// First call passes; capacity is 30, so a tight loop eventually trips the limit.
		await expect(t.mutation(internal.mail.ai.gate.assertAiAllowed, {})).resolves.toBeNull();

		let succeeded = 1;
		let limited = false;
		for (let i = 0; i < 50; i++) {
			try {
				await t.mutation(internal.mail.ai.gate.assertAiAllowed, {});
				succeeded += 1;
			} catch {
				limited = true;
				break;
			}
		}
		expect(limited).toBe(true);
		expect(succeeded).toBeGreaterThan(1);
		expect(succeeded).toBeLessThanOrEqual(31); // capacity 30 + the first call
	});

	it('charges a per-feature bucket that is independent of the default Postbox bucket', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);

		// Drain the translate bucket completely.
		let translateLimited = false;
		for (let i = 0; i < 60; i++) {
			try {
				await t.mutation(internal.mail.ai.gate.assertAiAllowed, {
					rateLimitBucket: 'translateBatchPerUser',
				});
			} catch {
				translateLimited = true;
				break;
			}
		}
		expect(translateLimited).toBe(true);

		// A different feature's bucket (and the default) still has headroom — the
		// per-feature buckets don't share a token pool.
		await expect(
			t.mutation(internal.mail.ai.gate.assertAiAllowed, { rateLimitBucket: 'quickQueryPerUser' })
		).resolves.toBeNull();
		await expect(t.mutation(internal.mail.ai.gate.assertAiAllowed, {})).resolves.toBeNull();
	});

	it('rejects a session-less call that names no owner instead of sharing a key', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);
		auth.session = null;
		await expect(t.mutation(internal.mail.ai.gate.assertAiAllowed, {})).rejects.toThrow(
			MISSING_AI_OWNER_MESSAGE
		);
		// Even with AI off: a caller that names nobody is a bug, not a refusal.
		const off = convexTest(schema, modules);
		rateLimiterTest.register(off);
		await setAiFlag(off, false);
		await expect(off.mutation(internal.mail.ai.gate.assertAiAllowed, {})).rejects.toThrow(
			MISSING_AI_OWNER_MESSAGE
		);
	});

	it('keeps two owners’ background work in separate buckets', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);
		auth.session = null;

		const drain = async (ownerUserId: string) => {
			for (let i = 0; i < 200; i++) {
				const error = await t.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId }).then(
					() => null,
					(e: unknown) => e
				);
				if (error) return { allowed: i, error };
			}
			return { allowed: 200, error: null };
		};
		// Owner A's arrival burst empties A's background bucket (capacity 120)...
		const a = await drain('owner-a');
		expect(a.allowed).toBe(120);
		expect(rateLimitRefusalOf(a.error)).not.toBeNull();
		// ...and owner B's background work is untouched by it.
		await expect(
			t.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId: 'owner-b' })
		).resolves.toBeNull();

		// Nor is owner A's interactive bucket: a click still goes through.
		auth.session = { userId: 'owner-a' };
		await expect(
			t.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId: 'ignored' })
		).resolves.toBeNull();
	});

	it('charges a session call to the session user, never to the background bucket', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);
		// Drain test-user's interactive bucket (capacity 30).
		for (let i = 0; i < 30; i++) {
			await t.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId: 'test-user' });
		}
		const limited = await t.mutation(internal.mail.ai.gate.assertAiAllowed, {}).then(
			() => null,
			(e: unknown) => e
		);
		expect(rateLimitRefusalOf(limited)).toMatchObject({ retryAfter: expect.any(Number) });
		// The same user's background work keeps its own headroom.
		auth.session = null;
		await expect(
			t.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId: 'test-user' })
		).resolves.toBeNull();
	});
});

describe('rateLimitRefusalOf', () => {
	it('recognises only the rate-limited operation error', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, false);
		const forbidden = await t.mutation(internal.mail.ai.gate.assertAiAllowed, {}).then(
			() => null,
			(e: unknown) => e
		);
		expect(forbidden).not.toBeNull();
		expect(rateLimitRefusalOf(forbidden)).toBeNull();
		expect(rateLimitRefusalOf(new Error('rate_limited'))).toBeNull();
		expect(rateLimitRefusalOf(undefined)).toBeNull();
	});
});
