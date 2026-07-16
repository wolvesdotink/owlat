import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	assertSingletonOrgInvariant,
	requireOrgMember,
	isActiveOrgMember,
	_resetSingletonOrgCacheForTests,
} from '../lib/sessionOrganization';

/**
 * Unit tests for the single-organization-per-deployment runtime invariant.
 *
 * The invariant lives in `apps/api/convex/lib/sessionOrganization.ts` and is
 * wired into `getBetterAuthSessionWithRole` so every authenticated query and
 * mutation flowing through `getMutationContext` enforces it.
 *
 * Owlat is single-org by product design (see CLAUDE.md / docs). This test file
 * documents the three failure modes the invariant guards against:
 *   1. Zero organizations exist (broken bootstrap).
 *   2. Multiple organizations exist (defense in depth — bypassed BetterAuth flag,
 *      direct DB import, future regression).
 *   3. Session's activeOrganizationId does not match the singleton's id.
 */

type OrgRow = { id?: string; _id?: string };

/**
 * Build a minimal `QueryCtx`-shaped object whose only used surface is
 * `ctx.runQuery`. The invariant calls `findMany` on the BetterAuth
 * `organization` model — we intercept that call and return the supplied rows.
 */
function makeCtx(rows: OrgRow[]) {
	return {
		runQuery: vi.fn(async () => ({ page: rows })),
		// The runtime ctx has many more fields; the invariant only uses runQuery,
		// so the cast through `unknown` is safe for this unit test.
	} as unknown as Parameters<typeof assertSingletonOrgInvariant>[0];
}

describe('assertSingletonOrgInvariant', () => {
	beforeEach(() => {
		// The invariant caches the validated singleton id per-isolate; reset
		// between tests so each case re-exercises the DB path.
		_resetSingletonOrgCacheForTests();
	});

	it('passes when exactly one organization exists and the session matches it', async () => {
		const ctx = makeCtx([{ id: 'org_singleton' }]);

		await expect(assertSingletonOrgInvariant(ctx, 'org_singleton')).resolves.toBeUndefined();
	});

	it('passes with a raw `_id`-only doc (current component shape — no `id` field)', async () => {
		// The live adapter returns RAW component docs: current versions expose the
		// org id only as `_id` (the component generates it and rejects a
		// client-supplied `id`). Reading only `.id` made every authed query throw
		// "No organization configured" on healthy new deployments.
		const ctx = makeCtx([{ _id: 'org_singleton' }]);

		await expect(assertSingletonOrgInvariant(ctx, 'org_singleton')).resolves.toBeUndefined();
	});

	it('throws when zero organizations exist (broken bootstrap)', async () => {
		const ctx = makeCtx([]);

		await expect(assertSingletonOrgInvariant(ctx, 'org_anything')).rejects.toThrow(
			/No organization configured/
		);
	});

	it('throws when two or more organizations exist', async () => {
		const ctx = makeCtx([{ id: 'org_a' }, { id: 'org_b' }]);

		await expect(assertSingletonOrgInvariant(ctx, 'org_a')).rejects.toThrow(
			/Multi-organization mode is not supported/
		);
	});

	it('throws when the session points at a different org than the singleton', async () => {
		const ctx = makeCtx([{ id: 'org_singleton' }]);

		await expect(assertSingletonOrgInvariant(ctx, 'org_stale_or_attacker')).rejects.toThrow(
			/does not match the deployment singleton/
		);
	});

	it('throws when findMany returns null page (defensive: BetterAuth adapter quirk)', async () => {
		const ctx = {
			runQuery: vi.fn(async () => null),
		} as unknown as Parameters<typeof assertSingletonOrgInvariant>[0];

		await expect(assertSingletonOrgInvariant(ctx, 'org_anything')).rejects.toThrow(
			/No organization configured/
		);
	});

	it('caches the validated singleton id and skips runQuery on subsequent calls', async () => {
		const ctx = makeCtx([{ id: 'org_singleton' }]);
		const runQueryMock = ctx.runQuery as ReturnType<typeof vi.fn>;

		await assertSingletonOrgInvariant(ctx, 'org_singleton');
		expect(runQueryMock).toHaveBeenCalledTimes(1);

		// Cache hit — no extra DB call.
		await assertSingletonOrgInvariant(ctx, 'org_singleton');
		expect(runQueryMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a mismatched org via the cache without re-querying', async () => {
		const ctx = makeCtx([{ id: 'org_singleton' }]);
		const runQueryMock = ctx.runQuery as ReturnType<typeof vi.fn>;

		await assertSingletonOrgInvariant(ctx, 'org_singleton');
		expect(runQueryMock).toHaveBeenCalledTimes(1);

		await expect(assertSingletonOrgInvariant(ctx, 'org_attacker')).rejects.toThrow(
			/does not match the deployment singleton/
		);
		// Cache makes the second call a pure equality check — no DB round trip.
		expect(runQueryMock).toHaveBeenCalledTimes(1);
	});
});

// ─── Membership floor (authedQuery / authedAction) ──────────────────────────
//
// requireOrgMember is the shared floor for authedQuery and the authedAction
// internal assert. isActiveOrgMember is its soft (non-throwing) sibling for
// publicQuery soft-fail reads. These tests pin the security-critical behaviour:
// an authenticated identity that is NOT a member of the singleton org is
// rejected, closing the open-signup → org-data-read leak.

/**
 * Structural ctx whose `auth.getUserIdentity` and `runQuery` drive
 * getBetterAuthSessionWithRole. `identity` is returned verbatim (include
 * `activeOrganizationId` to skip the session-table fallback); `runQuery`
 * answers the singleton-org `findMany` and the `member` `findOne` by model.
 */
function makeMemberCtx(opts: {
	identity: { subject?: string; activeOrganizationId?: string | null } | null;
	member: { role: string } | null;
	orgId?: string;
}) {
	const orgId = opts.orgId ?? 'org_singleton';
	return {
		auth: { getUserIdentity: vi.fn(async () => opts.identity) },
		runQuery: vi.fn(async (_ref: unknown, args: { model?: string }) => {
			if (args?.model === 'organization') return { page: [{ id: orgId }] };
			if (args?.model === 'member') return opts.member;
			return null;
		}),
	} as unknown as Parameters<typeof requireOrgMember>[0];
}

describe('requireOrgMember', () => {
	beforeEach(() => _resetSingletonOrgCacheForTests());

	it('returns { userId, role, activeOrganizationId } for an active member', async () => {
		const ctx = makeMemberCtx({
			identity: { subject: 'user_1', activeOrganizationId: 'org_singleton' },
			member: { role: 'owner' },
		});
		await expect(requireOrgMember(ctx)).resolves.toEqual({
			userId: 'user_1',
			role: 'owner',
			activeOrganizationId: 'org_singleton',
		});
	});

	it('throws for an authenticated NON-member (the open-signup leak)', async () => {
		const ctx = makeMemberCtx({
			identity: { subject: 'stranger', activeOrganizationId: 'org_singleton' },
			member: null, // self-registered identity, never added to the org
		});
		await expect(requireOrgMember(ctx)).rejects.toThrow(/do not have access/);
	});

	it('throws when the session has no active organization', async () => {
		const ctx = makeMemberCtx({
			identity: { subject: 'user_1', activeOrganizationId: null },
			member: { role: 'owner' },
		});
		await expect(requireOrgMember(ctx)).rejects.toThrow(/No active organization/);
	});

	it('throws for an anonymous caller', async () => {
		const ctx = makeMemberCtx({ identity: null, member: null });
		await expect(requireOrgMember(ctx)).rejects.toThrow();
	});
});

describe('isActiveOrgMember', () => {
	beforeEach(() => _resetSingletonOrgCacheForTests());

	it('is true for an active member', async () => {
		const ctx = makeMemberCtx({
			identity: { subject: 'user_1', activeOrganizationId: 'org_singleton' },
			member: { role: 'editor' },
		});
		await expect(isActiveOrgMember(ctx)).resolves.toBe(true);
	});

	it('is false for an authenticated non-member', async () => {
		const ctx = makeMemberCtx({
			identity: { subject: 'stranger', activeOrganizationId: 'org_singleton' },
			member: null,
		});
		await expect(isActiveOrgMember(ctx)).resolves.toBe(false);
	});

	it('is false for an anonymous caller', async () => {
		const ctx = makeMemberCtx({ identity: null, member: null });
		await expect(isActiveOrgMember(ctx)).resolves.toBe(false);
	});
});
