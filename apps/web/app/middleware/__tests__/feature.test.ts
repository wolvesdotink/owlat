/**
 * `feature.global` route gate.
 *
 * The guard half runs the shipped `useFeatureFlag` → `useConvexQuery` over a
 * fake Convex client, so the "never bounce while flags are still loading" rule
 * is exercised against the real subscription state, not a stubbed `isLoading`.
 * The path → flag table itself is pinned in `lib/__tests__/routeFeatureGates.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@owlat/api';
import type { RouteLocationNormalized } from 'vue-router';
import {
	authClientMock,
	loadMiddleware,
	resetSession,
	route,
	type Redirect,
} from '~/__tests__/middlewareHarness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Redirect | undefined;

async function load() {
	return loadMiddleware<Middleware>(() => import('../feature.global'));
}

const FLAGS_QUERY = api.workspaces.featureFlags.getFeatureFlags;

beforeEach(resetSession);

/**
 * The subscription opens on the guard's first `useFeatureFlag()` call, so a
 * loaded guard is navigated once (a deep link on a hard reload: flags not in
 * yet, no bounce) before the fake socket delivers them.
 */
async function loadWithFlags(flags: Record<string, boolean>) {
	const loaded = await load();
	const first = route('/dashboard/automations');
	expect(loaded.middleware(first, first)).toBeUndefined();
	loaded.convex!.deliver(FLAGS_QUERY, flags);
	return loaded;
}

describe('feature middleware — gating once flags are loaded', () => {
	it('does not bounce while the flag subscription has not delivered', async () => {
		const { middleware, convex } = await load();
		const to = route('/dashboard/automations');

		expect(middleware(to, to)).toBeUndefined();
		expect(convex!.subscriptionCount(FLAGS_QUERY)).toBe(1);
	});

	it('bounces a disabled section to the dashboard, naming the flag', async () => {
		const { middleware } = await loadWithFlags({ campaigns: false, automations: true });
		const to = route('/dashboard/campaigns/new');

		expect(middleware(to, to)).toEqual({
			redirect: { path: '/dashboard', query: { disabled: 'campaigns' } },
			options: { replace: true },
		});
	});

	it('lets an enabled section through', async () => {
		const { middleware } = await loadWithFlags({ campaigns: true });
		const to = route('/dashboard/campaigns/new');

		expect(middleware(to, to)).toBeUndefined();
	});

	it('keeps one shared subscription across navigations', async () => {
		const { middleware, convex } = await loadWithFlags({ campaigns: true, inbox: true });

		middleware(route('/dashboard/campaigns'), home());
		middleware(route('/dashboard/inbox'), home());
		expect(convex!.subscriptionCount(FLAGS_QUERY)).toBe(1);
	});

	it('follows a later flag change without a reload', async () => {
		const { middleware, convex } = await loadWithFlags({ inbox: true });
		const to = route('/dashboard/inbox');
		expect(middleware(to, to)).toBeUndefined();

		convex!.deliver(FLAGS_QUERY, { inbox: false });
		expect(middleware(to, to)).toEqual({
			redirect: { path: '/dashboard', query: { disabled: 'inbox' } },
			options: { replace: true },
		});
	});

	it('gates the postbox on either of its flags', async () => {
		const { middleware, convex } = await loadWithFlags({ postbox: false, 'mail.external': true });
		const to = route('/dashboard/postbox/inbox');

		expect(middleware(to, to)).toBeUndefined();

		convex!.deliver(FLAGS_QUERY, { postbox: false, 'mail.external': false });
		expect(middleware(to, to)).toEqual({
			redirect: { path: '/dashboard', query: { disabled: 'postbox' } },
			options: { replace: true },
		});
	});

	it('lets Recently deleted through with campaigns off', async () => {
		const { middleware } = await loadWithFlags({ campaigns: false });
		const to = route('/dashboard/marketing/deleted');

		expect(middleware(to, to)).toBeUndefined();
	});

	it('gates a page by its own path, deeper than its section', async () => {
		const { middleware } = await loadWithFlags({ 'ai.knowledge.analytics': false });
		const to = route('/dashboard/knowledge/graph');

		expect(middleware(to, to)).toEqual({
			redirect: { path: '/dashboard', query: { disabled: 'ai.knowledge.analytics' } },
			options: { replace: true },
		});
	});

	it('never bounces the dashboard root', async () => {
		const { middleware } = await loadWithFlags({ chat: false });
		const to = route('/dashboard');

		expect(middleware(to, to)).toBeUndefined();
	});

	it('leaves ungated built-ins alone without touching the flags', async () => {
		const { middleware, convex } = await load();
		const to = route('/dashboard/files/abc');

		expect(middleware(to, to)).toBeUndefined();
		expect(convex!.subscriptionCount(FLAGS_QUERY)).toBe(0);
	});
});

function home() {
	return route('/dashboard');
}
