import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

/**
 * H3: `userProfiles.create` binds the stored email to the VERIFIED identity
 * email from the JWT and IGNORES the client-supplied `args.email`. The claim
 * paths (mail/pendingInboxMembership, mail/pendingMailbox) match a caller's
 * profile email against reserved grants, so trusting a client value here would
 * let a caller register any address and hijack a teammate's reservation.
 */

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ([`../../auth/${key.slice(3)}`, val] as const)
			: ([key, val] as const)
	)
);

describe('userProfiles.create — email bound to verified identity', () => {
	it('stores the identity email (normalized), ignoring the client-supplied value', async () => {
		const t = convexTest(schema, modules);

		const profileId = await t
			.withIdentity({ subject: 'auth-1', email: 'User@Example.com' })
			.mutation(api.auth.userProfiles.create, {
				authUserId: 'auth-1',
				// Attacker-controlled value that must NOT be trusted.
				email: 'victim@teammate.com',
				name: 'Alice',
			});

		const stored = await t.run(async (ctx) => ctx.db.get(profileId));
		expect(stored?.email).toBe('user@example.com');
		expect(stored?.email).not.toBe('victim@teammate.com');
	});

	it('rejects creating a profile for a different auth user id', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t
				.withIdentity({ subject: 'auth-1', email: 'user@example.com' })
				.mutation(api.auth.userProfiles.create, {
					authUserId: 'someone-else',
					email: 'user@example.com',
				})
		).rejects.toThrow(/different user/);
	});

	it('fails closed when the authenticated identity carries no email', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.withIdentity({ subject: 'auth-1' }).mutation(api.auth.userProfiles.create, {
				authUserId: 'auth-1',
				email: 'client@example.com',
			})
		).rejects.toThrow(/valid email/);
	});

	it('is idempotent and never rewrites the bound email from a later client value', async () => {
		const t = convexTest(schema, modules);
		const caller = t.withIdentity({ subject: 'auth-1', email: 'user@example.com' });

		const first = await caller.mutation(api.auth.userProfiles.create, {
			authUserId: 'auth-1',
			email: 'user@example.com',
		});
		const second = await caller.mutation(api.auth.userProfiles.create, {
			authUserId: 'auth-1',
			email: 'attacker@evil.com',
		});

		expect(second).toBe(first);
		const stored = await t.run(async (ctx) => ctx.db.get(first));
		expect(stored?.email).toBe('user@example.com');
	});
});
