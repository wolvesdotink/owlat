/**
 * `admin` route guard, run through the shipped composable chain
 * (`useAuth` → `useOrganizationContext` → `useActiveMemberRole` /
 * `useOrganization` → `usePermissions`) over a fake session. The member's role
 * comes from the one `getActiveMember` lookup the guard has to wait for, the way
 * it does in the browser; the member and invitation lists play no part.
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
	getActiveMember,
	listInvitations,
	listMembers,
	loadMiddleware,
	resetSession,
	route,
	session,
	signIn,
	ORGANIZATION,
	USER,
	useActiveOrganization,
	useListOrganizations,
	type Redirect,
} from '~/__tests__/middlewareHarness';

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

	it('waits for the role lookup before deciding', async () => {
		signIn({ role: 'admin' });
		let releaseRole!: () => void;
		getActiveMember.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseRole = () =>
						resolve({
							data: { userId: USER.id, role: 'admin', organizationId: ORGANIZATION.id },
							error: null,
						});
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

		releaseRole();
		await expect(decision).resolves.toBeUndefined();
	});

	it('lets an owner through before the full organization request has answered', async () => {
		// The role used to come from the member list, whose fetch waited on
		// better-auth's separate full-organization request; a cold admin deep
		// link then bounced the owner (nothing was "loading" yet) until the guard
		// learned to wait for that request too. The role is now looked up from the
		// session's organization id, so the full organization arriving late (or
		// never) cannot hold the decision up or flip it.
		signIn({ role: 'owner' });
		session.organizations.value = [];
		const { middleware } = await load();

		await expect(middleware(to, to)).resolves.toBeUndefined();
	});

	it('never loads the member or invitation lists to decide', async () => {
		signIn({ role: 'owner' });
		const { middleware } = await load();

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(getActiveMember).toHaveBeenCalledOnce();
		expect(listMembers).not.toHaveBeenCalled();
		expect(listInvitations).not.toHaveBeenCalled();
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

	it('fails closed to Home when the role cannot be loaded', async () => {
		signIn({ role: 'owner' });
		getActiveMember.mockRejectedValueOnce(new Error('network down'));
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
		expect(getActiveMember).not.toHaveBeenCalled();
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
