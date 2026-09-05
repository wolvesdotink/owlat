/**
 * `feature.global` route gate.
 *
 * The guard half runs the shipped `useFeatureFlag` → `useConvexQuery` over a
 * fake Convex client, so the "never bounce while flags are still loading" rule
 * is exercised against the real subscription state, not a stubbed `isLoading`.
 * The `pathRule` half pins the path → flag table that keeps route gating from
 * drifting away from the sidebar's link-hiding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@owlat/api';
import type { RouteLocationNormalized } from 'vue-router';
import { authClientMock, loadMiddleware, resetSession, route, type Redirect } from './harness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Redirect | undefined;
type FeatureModule = typeof import('../feature.global');

let pathRule: FeatureModule['pathRule'];
let PATH_FEATURE_RULES: FeatureModule['PATH_FEATURE_RULES'];

async function load() {
	let mod!: FeatureModule;
	const loaded = await loadMiddleware<Middleware>(async () => {
		mod = await import('../feature.global');
		return mod;
	});
	pathRule = mod.pathRule;
	PATH_FEATURE_RULES = mod.PATH_FEATURE_RULES;
	return loaded;
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

	it('honours an explicit page-meta requirement over the path rule', async () => {
		const { middleware } = await loadWithFlags({ campaigns: true, 'ai.knowledge': false });
		const to = route('/dashboard/campaigns', { meta: { requiresFeature: 'ai.knowledge' } });

		expect(middleware(to, to)).toEqual({
			redirect: { path: '/dashboard', query: { disabled: 'ai.knowledge' } },
			options: { replace: true },
		});
	});

	it('requires every flag of an AND group and names the first missing one', async () => {
		const { middleware } = await loadWithFlags({ campaigns: true, automations: false });
		const to = route('/dashboard/reports', {
			meta: { requiresFeature: ['campaigns', 'automations'] },
		});

		expect(middleware(to, to)).toEqual({
			redirect: { path: '/dashboard', query: { disabled: 'automations' } },
			options: { replace: true },
		});
	});

	it('lets a page opt out of the path-derived gate', async () => {
		const { middleware } = await loadWithFlags({ campaigns: false });
		const to = route('/dashboard/campaigns/help', { meta: { publicFeature: true } });

		expect(middleware(to, to)).toBeUndefined();
	});

	it('never bounces the dashboard root, even with an explicit requirement', async () => {
		const { middleware } = await loadWithFlags({ chat: false });
		const to = route('/dashboard', { meta: { requiresFeature: 'chat' } });

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

describe('pathRule — path-derived feature gate', () => {
	beforeEach(load);

	it('gates the previously-ungated sections', () => {
		expect(pathRule('/dashboard/campaigns')?.required).toBe('campaigns');
		expect(pathRule('/dashboard/campaigns/new')?.required).toBe('campaigns');
		expect(pathRule('/dashboard/automations/123/edit')?.required).toBe('automations');
		expect(pathRule('/dashboard/visualizations')?.required).toBe('ai.visualizations');
		expect(pathRule('/dashboard/send/marketing')?.required).toBe('campaigns');
		expect(pathRule('/dashboard/send/transactional/x')?.required).toBe('transactional');
		expect(pathRule('/dashboard/knowledge/abc')?.required).toBe('ai.knowledge');
	});

	it('gates the transactional list AND editor tree under /dashboard/send', () => {
		expect(pathRule('/dashboard/send/transactional')?.required).toBe('transactional');
		expect(pathRule('/dashboard/send/transactional/x/edit')?.required).toBe('transactional');
		expect(pathRule('/dashboard/send/transactional/x/sends/y')?.required).toBe('transactional');
		expect(pathRule('/dashboard/send/transactional/x/translations')?.required).toBe(
			'transactional'
		);
	});

	it('keeps the already-gated sections', () => {
		expect(pathRule('/dashboard/inbox/quarantine')?.required).toBe('inbox');
		expect(pathRule('/dashboard/chat')?.required).toBe('chat');
		expect(pathRule('/dashboard/postbox/inbox')?.anyOf).toEqual(['postbox', 'mail.external']);
	});

	it('leaves always-on built-ins ungated', () => {
		expect(pathRule('/dashboard')).toBeUndefined();
		expect(pathRule('/dashboard/send')).toBeUndefined();
		expect(pathRule('/dashboard/send/blocks')).toBeUndefined();
		expect(pathRule('/dashboard/send/media')).toBeUndefined();
		expect(pathRule('/dashboard/send/emails/abc/edit')).toBeUndefined();
		expect(pathRule('/dashboard/files/abc')).toBeUndefined();
		expect(pathRule('/dashboard/audience/contacts')).toBeUndefined();
		expect(pathRule('/dashboard/admin/team/api')).toBeUndefined();
	});

	it('does not match a prefix that is only a partial path segment', () => {
		expect(pathRule('/dashboard/campaignsX')).toBeUndefined();
		expect(pathRule('/dashboard/inboxes')).toBeUndefined();
	});

	it('picks the longest matching prefix (send/marketing over any send rule)', () => {
		const rule = pathRule('/dashboard/send/marketing/anything');
		expect(rule?.prefix).toBe('/dashboard/send/marketing');
		expect(rule?.required).toBe('campaigns');
	});

	it('every rule maps to a real path under /dashboard', () => {
		for (const rule of PATH_FEATURE_RULES) {
			expect(rule.prefix.startsWith('/dashboard/')).toBe(true);
		}
	});
});
