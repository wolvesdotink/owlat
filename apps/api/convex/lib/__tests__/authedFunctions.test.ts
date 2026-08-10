/**
 * The builder layer's own contract — the floor it runs, and the SESSION it
 * threads.
 *
 * Every org-scoped builder resolves a full `MutationSessionContext` to decide its
 * floor, and hands that same object to the handler as a third argument, so a
 * handler needing `role` / `activeOrganizationId` costs ONE BetterAuth session +
 * `member` resolution instead of two. Three shipped endpoints depend on that
 * (`analytics.adaptiveDashboard.getAvailableCards`,
 * `delivery.observabilityStatus.get`, `delivery.checklist.getCenter`) and each
 * pins the call count from its own side; this file pins the property at the layer
 * all of them share, including the two ways it could regress invisibly:
 *
 *   - a builder that resolves its floor and DROPS the result — the shape every one
 *     of these wrappers had before. Handlers go back to re-resolving, and no
 *     endpoint test that mocks the session helpers fails; the query just costs
 *     twice as much again.
 *   - `featureGated`, which re-wraps a builder's handler. It forwards
 *     positionally, so `chatQuery` / `assistantQuery` thread the session exactly
 *     like the `authedQuery` they compose. Name `args` there instead and the
 *     session silently becomes `undefined` for every feature-gated module.
 *
 * Handlers are driven through `_handler` — the inner function Convex's
 * registration attaches to the registered object, which is what a real invocation
 * calls after argument validation — with a fake ctx: the floors are mocked, the
 * flag check is mocked, and the handlers under test touch neither the database nor
 * the identity. What is measured is the wrapper's plumbing, not a query.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import {
	authedQuery,
	authedMutation,
	adminQuery,
	adminMutation,
	ownerMutation,
	featureGated,
} from '../authedFunctions';
import * as sessionOrganization from '../sessionOrganization';
import type { MutationSessionContext } from '../sessionOrganization';
import * as featureFlags from '../featureFlags';

const MEMBER: MutationSessionContext = {
	userId: 'user-member',
	role: 'editor',
	activeOrganizationId: 'org-1',
};
const ADMIN: MutationSessionContext = {
	userId: 'user-admin',
	role: 'admin',
	activeOrganizationId: 'org-1',
};
const OWNER: MutationSessionContext = {
	userId: 'user-owner',
	role: 'owner',
	activeOrganizationId: 'org-1',
};

vi.mock('../sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../sessionOrganization')>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => MEMBER),
		getMutationContext: vi.fn(async () => MEMBER),
		requireAdminContext: vi.fn(async () => ADMIN),
		requireOwnerContext: vi.fn(async () => OWNER),
		requireOrgPermission: vi.fn(async () => ADMIN),
	};
});

vi.mock('../featureFlags', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../featureFlags')>();
	return { ...actual, assertFeatureEnabled: vi.fn(async () => undefined) };
});

/** Identity-comparable and deliberately featureless — no handler here reads it. */
const ctx = { db: 'fake-db' } as unknown as QueryCtx & MutationCtx;

function invoke(registered: unknown, args: unknown = {}): Promise<unknown> {
	const inner = registered as { _handler: (c: unknown, a: unknown) => Promise<unknown> };
	return inner._handler(ctx, args);
}

/** Reports exactly what the wrapper passed in. */
function echo(
	handlerCtx: unknown,
	args: unknown,
	session: MutationSessionContext
): Promise<{ ctx: unknown; args: unknown; session: MutationSessionContext }> {
	return Promise.resolve({ ctx: handlerCtx, args, session });
}

/** The builders erase their config type through a cast; tests build them loosely. */
type LooseBuilder = (config: {
	args: Record<string, never>;
	handler: (c: never, a: never, s: never) => unknown;
}) => unknown;

beforeEach(() => {
	vi.clearAllMocks();
});

describe('the org-scoped builders thread their floor’s session', () => {
	const cases = [
		{ name: 'authedQuery', build: authedQuery, floor: 'requireOrgMember', session: MEMBER },
		{ name: 'adminQuery', build: adminQuery, floor: 'requireOrgPermission', session: ADMIN },
		{ name: 'authedMutation', build: authedMutation, floor: 'getMutationContext', session: MEMBER },
		{ name: 'adminMutation', build: adminMutation, floor: 'requireAdminContext', session: ADMIN },
		{ name: 'ownerMutation', build: ownerMutation, floor: 'requireOwnerContext', session: OWNER },
	] as const;

	for (const { name, build, floor, session } of cases) {
		it(`${name} hands the handler the session ${floor} resolved, once`, async () => {
			const handler = vi.fn(echo);
			const fn = (build as unknown as LooseBuilder)({
				args: {},
				handler: handler as unknown as (c: never, a: never, s: never) => unknown,
			});

			const result = (await invoke(fn, { page: 2 })) as {
				ctx: unknown;
				args: unknown;
				session: unknown;
			};

			// The SAME object the floor returned, not a re-derived copy — and `ctx` /
			// `args` pass through untouched: nothing is spread onto, wrapped around or
			// bolted into the Convex context.
			expect(result.session).toBe(session);
			expect(result.ctx).toBe(ctx);
			expect(result.args).toEqual({ page: 2 });
			expect(vi.mocked(sessionOrganization[floor])).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledTimes(1);
		});
	}

	it('runs adminQuery’s floor as the organization:manage permission gate', async () => {
		await invoke(adminQuery({ args: {}, handler: echo }));
		expect(vi.mocked(sessionOrganization.requireOrgPermission)).toHaveBeenCalledWith(
			ctx,
			'organization:manage'
		);
	});

	it('leaves a handler that ignores the session completely alone', async () => {
		// The shipped majority: two declared parameters, third argument discarded by
		// the language, behaviour identical to before the session was threaded.
		const handler = vi.fn((_ctx: unknown, args: unknown) => Promise.resolve(args));
		const fn = (authedQuery as unknown as LooseBuilder)({
			args: {},
			handler: handler as unknown as (c: never, a: never, s: never) => unknown,
		});

		await expect(invoke(fn, { id: 'x' })).resolves.toEqual({ id: 'x' });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('never reaches the handler when the floor refuses', async () => {
		vi.mocked(sessionOrganization.requireOrgMember).mockRejectedValueOnce(
			new Error('Not authenticated')
		);
		const handler = vi.fn(echo);
		const fn = (authedQuery as unknown as LooseBuilder)({
			args: {},
			handler: handler as unknown as (c: never, a: never, s: never) => unknown,
		});

		await expect(invoke(fn)).rejects.toThrow(/Not authenticated/);
		expect(handler).not.toHaveBeenCalled();
	});

	it('threads a session whose activeOrganizationId is a plain string, not an optional', async () => {
		// Typed against the floor's own return type: a floor that stopped resolving
		// one of the three fields fails to compile here rather than handing a handler
		// `undefined` at runtime.
		const scope = await invoke(
			adminQuery({
				args: {},
				handler: (_ctx, _args, session) => Promise.resolve(session.activeOrganizationId),
			})
		);
		expect(scope).toBe('org-1');
	});
});

describe('featureGated forwards what the builder it wraps hands the handler', () => {
	it('threads args AND the session through the flag floor', async () => {
		const gated = featureGated(authedQuery, 'chat');
		const handler = vi.fn(echo);
		const fn = (gated as unknown as LooseBuilder)({
			args: {},
			handler: handler as unknown as (c: never, a: never, s: never) => unknown,
		});

		const result = (await invoke(fn, { roomId: 'room-1' })) as {
			args: unknown;
			session: unknown;
		};

		expect(result.session).toBe(MEMBER);
		expect(result.args).toEqual({ roomId: 'room-1' });
		expect(vi.mocked(featureFlags.assertFeatureEnabled)).toHaveBeenCalledWith(ctx, 'chat');
	});

	it('keeps the order auth floor → flag floor → handler', async () => {
		const order: string[] = [];
		vi.mocked(sessionOrganization.getMutationContext).mockImplementationOnce(async () => {
			order.push('floor');
			return MEMBER;
		});
		vi.mocked(featureFlags.assertFeatureEnabled).mockImplementationOnce(async () => {
			order.push('flag');
		});
		const gated = featureGated(authedMutation, 'chat');
		const fn = (gated as unknown as LooseBuilder)({
			args: {},
			handler: (() => {
				order.push('handler');
				return Promise.resolve(null);
			}) as unknown as (c: never, a: never, s: never) => unknown,
		});

		await invoke(fn);

		expect(order).toEqual(['floor', 'flag', 'handler']);
	});

	it('does not run the flag check when the auth floor refuses first', async () => {
		vi.mocked(sessionOrganization.requireOrgMember).mockRejectedValueOnce(
			new Error('You do not have access to this organization')
		);
		const gated = featureGated(authedQuery, 'chat');
		const handler = vi.fn(echo);
		const fn = (gated as unknown as LooseBuilder)({
			args: {},
			handler: handler as unknown as (c: never, a: never, s: never) => unknown,
		});

		await expect(invoke(fn)).rejects.toThrow(/do not have access/);
		expect(vi.mocked(featureFlags.assertFeatureEnabled)).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});
});
