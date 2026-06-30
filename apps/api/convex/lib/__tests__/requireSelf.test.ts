import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { requireSelf } from '../sessionOrganization';
import type { QueryCtx } from '../../_generated/server';

/**
 * Minimal `ctx` exposing just `auth.getUserIdentity`, which is all
 * `requireSelf` → `getUserIdFromSession` → `getBetterAuthSession` touches when
 * the identity already carries `activeOrganizationId` (the session-lookup
 * branch is skipped). Anything else is left undefined on purpose.
 */
function ctxWithIdentity(identity: { subject: string } | null): QueryCtx {
	return {
		auth: {
			getUserIdentity: async () =>
				identity ? { ...identity, activeOrganizationId: null } : null,
		},
	} as unknown as QueryCtx;
}

/** Pull the OperationError category off a thrown ConvexError. */
function categoryOf(err: unknown): string | undefined {
	if (err instanceof ConvexError) {
		const data = err.data as { category?: string };
		return data.category;
	}
	return undefined;
}

describe('requireSelf', () => {
	it('returns the session user id when the claimed id matches', async () => {
		const ctx = ctxWithIdentity({ subject: 'auth-user-1' });
		await expect(requireSelf(ctx, 'auth-user-1')).resolves.toBe('auth-user-1');
	});

	it('throws forbidden (403) when an authenticated caller targets another user', async () => {
		const ctx = ctxWithIdentity({ subject: 'auth-user-1' });
		const err = await requireSelf(ctx, 'someone-else').then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConvexError);
		// Authenticated, just not authorized for that target → forbidden, not
		// unauthenticated.
		expect(categoryOf(err)).toBe('forbidden');
	});

	it('throws unauthenticated (401) when there is no session', async () => {
		const ctx = ctxWithIdentity(null);
		const err = await requireSelf(ctx, 'auth-user-1').then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ConvexError);
		expect(categoryOf(err)).toBe('unauthenticated');
	});
});
