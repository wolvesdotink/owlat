/**
 * `admin` route guard, run through the shipped composable chain
 * (`useAuth` → `useOrganizationContext` → `useOrganization` → `usePermissions`)
 * over a fake session. The member's role comes from the members list the
 * guard has to wait for, the way it does in the browser.
 *
 * Regression pinned here: 34 admin-gated pages 500'd when `useOrganization()`
 * gained an unguarded `useI18n()` — invisible to a suite that stubbed
 * `useOrganizationContext` away. `useI18n` is the real vue-i18n one below, and
 * the guard runs outside a component `setup()`, so that crash fails this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@owlat/api';
import { getCurrentInstance } from 'vue';
import type { RouteLocationNormalized } from 'vue-router';
import {
	authClientMock,
	listMembers,
	loadMiddleware,
	resetSession,
	route,
	session,
	signIn,
	useActiveOrganization,
	useListOrganizations,
	type Redirect,
} from './harness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Promise<Redirect | undefined>;

const load = () => loadMiddleware<Middleware>(() => import('../admin'));
const to = route('/dashboard/admin');

beforeEach(resetSession);

describe('admin middleware', () => {
	it('runs where useI18n() has no component instance, as the router guard does', async () => {
		await load();
		expect(getCurrentInstance()).toBeNull();
		expect(() => useI18n()).toThrow(/setup/);
	});

	it.each(['owner', 'admin'] as const)(
		'lets an %s through once the role resolves',
		async (role) => {
			signIn({ role });
			const { middleware } = await load();

			await expect(middleware(to, to)).resolves.toBeUndefined();
		}
	);

	it('bounces an editor deep link to Home with replace', async () => {
		signIn({ role: 'member' });
		const { middleware } = await load();

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/dashboard',
			options: { replace: true },
		});
	});

	it('waits for the member list before deciding', async () => {
		signIn({ role: 'admin' });
		let releaseMembers!: () => void;
		listMembers.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseMembers = () => resolve({ data: { members: session.members.value } });
				})
		);
		const { middleware } = await load();

		let settled = false;
		const decision = middleware(to, to).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		releaseMembers();
		await expect(decision).resolves.toBeUndefined();
	});

	it('waits when the active organization has not arrived yet', async () => {
		// The bug this pins: BetterAuth resolves the ACTIVE ORGANIZATION in its own
		// request, separate from the session. Until it lands there is no
		// organization id, so the members watcher has not fired, so nothing is
		// "loading" — and the guard used to read that as "loaded, not an admin"
		// and bounce the owner. Only reproducible when the org arrives LATE, which
		// is why a suite handing it over synchronously never saw it: in the browser
		// every cold load of an admin URL (a refresh, a bookmark, a deep link) sent
		// the instance owner to /dashboard, while in-app navigation worked because
		// the role was already cached.
		signIn({ role: 'owner' });
		const organizations = session.organizations.value;
		session.organizations.value = [];

		const { middleware } = await load();

		let settled = false;
		const decision = middleware(to, to).then((result) => {
			settled = true;
			return result;
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled, 'decided before the role could possibly be known').toBe(false);

		session.organizations.value = organizations;
		await expect(decision).resolves.toBeUndefined();
	});

	it('decides instead of hanging when the organization request fails', async () => {
		// The mirror of the test above, and the failure mode its fix could have
		// introduced. better-auth clears `activeOrganizationId` only when a member
		// removes THEMSELVES, so an admin removing someone leaves that person's
		// open tab naming an organization they are no longer in, and the request
		// settles FORBIDDEN. No organization means no role is ever coming: treat
		// it as an answer. Waiting instead would stall every guard for its whole
		// timeout and spin every page that folds this into a loading flag.
		signIn({ role: 'owner' });
		session.activeOrganizationError.value = { message: 'FORBIDDEN' };
		const { middleware } = await load();

		const decision = await Promise.race([
			middleware(to, to),
			new Promise((resolve) => setTimeout(() => resolve('HUNG'), 500)),
		]);

		expect(decision, 'the guard waited on a request that had already settled').not.toBe('HUNG');
		expect(decision).toEqual({ redirect: '/dashboard', options: { replace: true } });
	});

	it('fails closed to Home when the member list cannot be loaded', async () => {
		signIn({ role: 'owner' });
		listMembers.mockRejectedValueOnce(new Error('network down'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { middleware } = await load();

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/dashboard',
			options: { replace: true },
		});
		consoleError.mockRestore();
	});

	it('does not open another Convex subscription per navigation', async () => {
		// The guard calls `useOrganizationContext()` inside `runWithContext`, whose
		// effect scope is gone once the guard has awaited — so nothing would ever
		// unsubscribe. With 117 guarded pages that is one leaked workspace-settings
		// subscription per navigation. The query is a module singleton now, so the
		// count must not grow.
		signIn({ role: 'admin' });
		const { middleware, convex } = await load();

		await middleware(to, to);
		const afterFirst = convex!.subscriptionCount(api.workspaces.settings.get);
		expect(afterFirst).toBe(1);

		await middleware(to, to);
		expect(convex!.subscriptionCount(api.workspaces.settings.get)).toBe(afterFirst);
	});

	it('sends a signed-out visitor to sign in without loading the organization', async () => {
		const { middleware } = await load();

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/auth/login',
			options: undefined,
		});
		expect(listMembers).not.toHaveBeenCalled();
		// Constructing the organization stores IS the request: better-auth fetches
		// the full organization and the organization list as soon as the hooks are
		// built. A signed-out visitor would collect 401s from both on the way to
		// the login redirect, so the guard must not build them before it has
		// decided.
		expect(useActiveOrganization).not.toHaveBeenCalled();
		expect(useListOrganizations).not.toHaveBeenCalled();
	});

	it('holds a pending session until it settles, then decides on the outcome', async () => {
		session.pending.value = true;
		const { middleware } = await load();

		let settled = false;
		const decision = middleware(to, to).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		session.pending.value = false;
		await expect(decision).resolves.toEqual({ redirect: '/auth/login', options: undefined });
	});
});
