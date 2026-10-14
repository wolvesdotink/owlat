import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryCtx, MutationCtx } from '../../_generated/server';
import { authedQuery, adminQuery, authedMutation, publicQuery } from '../authedFunctions';
import {
	getBetterAuthSession,
	getBetterAuthSessionWithRole,
	getSingletonOrganizationId,
	requireOrgPermission,
	_resetSingletonOrgCacheForTests,
} from '../sessionOrganization';

type Identity = { subject: string; activeOrganizationId?: string | null; sessionId?: string };

function fixture(identity: Identity | null = { subject: 'user-1', activeOrganizationId: 'org-1' }) {
	const state = {
		identity,
		member: { role: 'admin' } as { role: string } | null,
		orgs: [{ _id: 'org-1' }],
		session: { activeOrganizationId: 'org-1', expiresAt: Date.now() + 60_000 },
	};
	const runQuery = vi.fn(
		async (
			_ref: unknown,
			args: {
				model: string;
				where?: Array<{ field: string; value: unknown }>;
			}
		) => {
			if (args.model === 'organization') return { page: state.orgs };
			if (args.model === 'member') return state.member;
			if (args.model === 'session') {
				const expiry = args.where?.find((filter) => filter.field === 'expiresAt');
				return expiry && state.session.expiresAt > Number(expiry.value) ? state.session : null;
			}
			throw new Error(`Unexpected model ${args.model}`);
		}
	);
	const ctx = {
		db: {},
		auth: { getUserIdentity: vi.fn(async () => state.identity) },
		runQuery,
	} as unknown as QueryCtx & MutationCtx;
	return { state, ctx, runQuery };
}

function invoke(fn: unknown, ctx: QueryCtx | MutationCtx) {
	return (fn as { _handler: (ctx: QueryCtx | MutationCtx, args: {}) => Promise<unknown> })._handler(
		ctx,
		{}
	);
}

const repeatedRead = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		// Exercise helpers used by nested readers, including concurrent callers.
		const [first, second] = await Promise.all([
			getBetterAuthSessionWithRole(ctx),
			requireOrgPermission(ctx, 'organization:manage'),
		]);
		expect(first).toEqual(session);
		expect(second).toEqual(session);
		await getBetterAuthSession(ctx);
		await getSingletonOrganizationId(ctx);
		return session;
	},
});

describe('authenticated query component calls', () => {
	// The validated singleton-org id is cached per isolate; start each case cold.
	beforeEach(() => _resetSingletonOrgCacheForTests());

	it('resolves JWT claims, singleton and live membership only once per invocation', async () => {
		const { ctx, runQuery } = fixture();
		await expect(invoke(repeatedRead, ctx)).resolves.toEqual({
			userId: 'user-1',
			activeOrganizationId: 'org-1',
			role: 'admin',
		});
		expect(runQuery.mock.calls.map(([, args]) => args.model)).toEqual(['organization', 'member']);
		expect(ctx.auth.getUserIdentity).toHaveBeenCalledTimes(1);
	});

	it('uses no component session lookup or clock read for normal JWT claims', async () => {
		const { ctx, runQuery } = fixture();
		const clock = vi.spyOn(Date, 'now');
		try {
			await invoke(repeatedRead, ctx);
			expect(clock).not.toHaveBeenCalled();
			expect(runQuery.mock.calls.some(([, args]) => args.model === 'session')).toBe(false);
		} finally {
			clock.mockRestore();
		}
	});

	it('does not share membership between distinct request contexts', async () => {
		const member = fixture();
		const stranger = fixture({ subject: 'stranger', activeOrganizationId: 'org-1' });
		stranger.state.member = null;
		await invoke(repeatedRead, member.ctx);
		await expect(invoke(repeatedRead, stranger.ctx)).rejects.toThrow(/do not have access/);
		// The singleton org id is deployment-wide and stays cached; membership is not.
		expect(stranger.runQuery.mock.calls.map(([, args]) => args.model)).toEqual(['member']);
	});

	it('coalesces rejected singleton checks without retrying component reads', async () => {
		const { state, ctx, runQuery } = fixture();
		state.orgs = [];
		const fn = publicQuery({
			args: {},
			handler: async (ctx) => {
				const results = await Promise.allSettled([
					getBetterAuthSessionWithRole(ctx),
					getBetterAuthSessionWithRole(ctx),
				]);
				expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
			},
		});
		await invoke(fn, ctx);
		expect(runQuery).toHaveBeenCalledTimes(1);
	});

	it('coalesces parallel legacy-token session resolutions', async () => {
		const { ctx, runQuery } = fixture({ subject: 'user-1', sessionId: 'session-1' });
		const fn = publicQuery({
			args: {},
			handler: async (ctx) => {
				await Promise.all([getBetterAuthSessionWithRole(ctx), getBetterAuthSessionWithRole(ctx)]);
			},
		});
		await invoke(fn, ctx);
		expect(runQuery.mock.calls.map(([, args]) => args.model)).toEqual([
			'session',
			'organization',
			'member',
		]);
	});

	it('reuses the legacy session loaded by the auth floor in nested readers', async () => {
		const { ctx, runQuery } = fixture({ subject: 'user-1', sessionId: 'session-1' });
		await invoke(repeatedRead, ctx);
		expect(runQuery.mock.calls.map(([, args]) => args.model)).toEqual([
			'session',
			'organization',
			'member',
		]);
		expect(ctx.auth.getUserIdentity).toHaveBeenCalledTimes(1);
	});

	it('checks membership again in a new invocation and rejects a removed member', async () => {
		const { state, ctx, runQuery } = fixture();
		await invoke(repeatedRead, ctx);
		state.member = null;
		await expect(invoke(repeatedRead, ctx)).rejects.toThrow(/do not have access/);
		expect(runQuery.mock.calls.map(([, args]) => args.model)).toEqual([
			'organization',
			'member',
			'member',
		]);
	});

	it('reads the singleton org once per isolate, membership once per invocation', async () => {
		const { ctx, runQuery } = fixture();
		await invoke(repeatedRead, ctx);
		await invoke(repeatedRead, ctx);
		expect(runQuery.mock.calls.map(([, args]) => args.model)).toEqual([
			'organization',
			'member',
			'member',
		]);
	});

	it('rejects non-members before invoking the handler', async () => {
		const { state, ctx, runQuery } = fixture();
		state.member = null;
		const handler = vi.fn();
		await expect(invoke(authedQuery({ args: {}, handler }), ctx)).rejects.toThrow(
			/do not have access/
		);
		expect(handler).not.toHaveBeenCalled();
		expect(runQuery).toHaveBeenCalledTimes(2);
	});

	it('rejects an expired legacy session without reading org or membership', async () => {
		const { state, ctx, runQuery } = fixture({ subject: 'user-1', sessionId: 'session-1' });
		state.session.expiresAt = 0;
		await expect(invoke(repeatedRead, ctx)).rejects.toThrow(/No active organization/);
		expect(runQuery.mock.calls.map(([, args]) => args.model)).toEqual(['session']);
	});

	it('rejects expired JWTs when Convex returns no validated identity', async () => {
		const { ctx, runQuery } = fixture(null);
		await expect(invoke(repeatedRead, ctx)).rejects.toThrow();
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('keeps role permission checks live between invocations', async () => {
		const { state, ctx, runQuery } = fixture();
		const fn = adminQuery({
			args: {},
			handler: async (ctx) => requireOrgPermission(ctx, 'organization:manage'),
		});
		await invoke(fn, ctx);
		state.member = { role: 'editor' };
		await expect(invoke(fn, ctx)).rejects.toThrow(/permission/);
		expect(runQuery.mock.calls.filter(([, args]) => args.model === 'member')).toHaveLength(2);
	});

	it('does not memoize membership in mutations that can change auth data', async () => {
		const { state, ctx, runQuery } = fixture();
		const fn = authedMutation({
			args: {},
			handler: async (ctx) => {
				state.member = null;
				await requireOrgPermission(ctx, 'organization:manage');
			},
		});
		await expect(invoke(fn, ctx)).rejects.toThrow(/do not have access/);
		expect(runQuery.mock.calls.filter(([, args]) => args.model === 'member')).toHaveLength(2);
	});
});
