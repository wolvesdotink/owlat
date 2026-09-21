import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

/**
 * L16: `onboarding.dismiss` hides an INSTANCE-WIDE surface, so it is gated on
 * `organization:manage` (admin/owner) in addition to the self binding — an
 * ordinary member must not be able to dismiss onboarding for every admin.
 */

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return {
		...actual,
		// Base floor of `authedMutation` — resolve the session (with the mocked
		// role) that the handler threads into its REAL
		// requirePermission(hasPermission(role, 'organization:manage')) gate, so the
		// editor rejection and admin acceptance are exercised end-to-end.
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
		requireSelf: vi.fn(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMocks.userId) {
				throw new Error('forbidden: not self');
			}
			return claimed;
		}),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ([`../../auth/${key.slice(3)}`, val] as const)
			: ([key, val] as const)
	)
);

describe('onboarding.dismiss — organization:manage gate', () => {
	it('rejects an ordinary member (editor)', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'user-A';
		sessionMocks.role = 'editor';

		await expect(t.mutation(api.auth.onboarding.dismiss, { userId: 'user-A' })).rejects.toThrow();

		const row = await t.run(async (ctx) => ctx.db.query('onboardingProgress').first());
		expect(row).toBeNull();
	});

	it('allows an admin and records the dismissal', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'user-A';
		sessionMocks.role = 'admin';

		await t.mutation(api.auth.onboarding.dismiss, { userId: 'user-A' });

		const row = await t.run(async (ctx) => ctx.db.query('onboardingProgress').first());
		expect(row?.dismissed).toBe(true);
		expect(typeof row?.dismissedAt).toBe('number');
	});

	it('still binds the recorded userId to the caller (self)', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'user-A';
		sessionMocks.role = 'admin';

		await expect(
			t.mutation(api.auth.onboarding.dismiss, { userId: 'someone-else' })
		).rejects.toThrow(/not self/);
	});
});
