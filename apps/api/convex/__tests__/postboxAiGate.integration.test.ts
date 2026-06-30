/**
 * mail.aiGate.assertAiAllowed — the spend-gate run before every Postbox LLM
 * call. Enforces the `ai` feature flag and the per-user rate limit.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
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

describe('mail.aiGate.assertAiAllowed', () => {
	it('throws when the ai feature flag is off', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, false);
		await expect(t.mutation(internal.mail.aiGate.assertAiAllowed, {})).rejects.toThrow(
			/disabled|forbidden/i
		);
	});

	it('allows calls while the ai flag is on, then rate-limits once the bucket drains', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await setAiFlag(t, true);

		// First call passes; capacity is 30, so a tight loop eventually trips the limit.
		await expect(t.mutation(internal.mail.aiGate.assertAiAllowed, {})).resolves.toBeNull();

		let succeeded = 1;
		let limited = false;
		for (let i = 0; i < 50; i++) {
			try {
				await t.mutation(internal.mail.aiGate.assertAiAllowed, {});
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
});
