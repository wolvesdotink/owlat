import { describe, expect, it } from 'vitest';
import type { BetterAuthOptions } from 'better-auth';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';

/**
 * `session.freshAge: 0` and `user.deleteUser` being off are ONE decision, and it
 * only holds while both halves do.
 *
 * BetterAuth's freshness gate is measured from session CREATION and is never
 * refreshed by `updateAge`, so with the 24h default and a 3-day session,
 * `/list-sessions` — the whole basis of the sign-in and security page — returns
 * SESSION_NOT_FRESH for two of every three days. Turning it off is safe here
 * only because the other two endpoints it gates are unreachable on this
 * instance: `/delete-user` needs `user.deleteUser.enabled` (account deletion
 * runs through convex/auth/accountManagement.ts instead) and `/unlink-account`
 * needs a social provider to unlink.
 *
 * Enabling either one silently re-opens a hole: `/delete-user` would then accept
 * a passwordless delete on a session of any age. This test is the tripwire.
 */
const ctx = {} as ActionCtx;

describe('session freshness', () => {
	// Widened to the declared option type: `createAuthOptions` returns an object
	// literal, so reading `user.deleteUser` off it would be a COMPILE error
	// ("property does not exist") rather than the runtime assertion this needs to
	// be — a compile error is what disappears the moment someone adds the key.
	const options = createAuthOptions(ctx) as unknown as BetterAuthOptions;

	it('turns the freshness gate off, so the sessions list is readable all session long', () => {
		expect(options.session?.freshAge).toBe(0);
	});

	it('keeps BetterAuth account deletion disabled, which is what makes that safe', () => {
		expect(options.user?.deleteUser?.enabled).not.toBe(true);
	});

	it('configures no social provider, so /unlink-account has nothing to unlink', () => {
		expect(options.socialProviders ?? {}).toEqual({});
	});
});
