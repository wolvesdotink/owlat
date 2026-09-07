/**
 * `auth` route guard over the shipped `useAuth` / `useOrganizationContext` /
 * `useOrganization` chain and a fake better-auth session. The organization
 * auto-activation path runs the real `setActive` (session refetch, active-org
 * sync, member fetch) against the mocked auth client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import {
	ORGANIZATION,
	authClientMock,
	enterDesktopRuntime,
	leaveDesktopRuntime,
	listOrganizations,
	loadMiddleware,
	resetSession,
	route,
	session,
	setActiveOrganization,
	signIn,
	type Redirect,
} from './harness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Promise<Redirect | undefined>;

const load = () => loadMiddleware<Middleware>(() => import('../auth'));

beforeEach(resetSession);
afterEach(leaveDesktopRuntime);

describe('auth middleware — signed out', () => {
	it('sends the visitor to sign in and remembers the deep link', async () => {
		const { middleware } = await load();
		const to = route('/dashboard/campaigns', { query: { tab: 'sent' } });

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: { path: '/auth/login', query: { redirect: '/dashboard/campaigns?tab=sent' } },
			options: undefined,
		});
	});

	it('does not carry the landing page as a return URL', async () => {
		const { middleware } = await load();
		const to = route('/');

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: { path: '/auth/login', query: undefined },
			options: undefined,
		});
	});

	it('sends the packaged desktop app back to its workspace screen instead', async () => {
		enterDesktopRuntime();
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/desktop/welcome',
			options: undefined,
		});
	});

	it('waits for a pending session before deciding', async () => {
		session.pending.value = true;
		const { middleware } = await load();
		const to = route('/dashboard');

		let settled = false;
		const decision = middleware(to, to).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		signIn();
		session.pending.value = false;
		await expect(decision).resolves.toBeUndefined();
	});
});

describe('auth middleware — signed in', () => {
	it('lets a member with an active organization through', async () => {
		signIn();
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(listOrganizations).not.toHaveBeenCalled();
	});

	it('activates the first organization the member belongs to when none is active', async () => {
		signIn({ organization: false });
		session.organizations.value = [ORGANIZATION];
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: ORGANIZATION.id });
		expect(session.activeOrganizationId.value).toBe(ORGANIZATION.id);
	});

	it('sends a member of no organization to the access-request page', async () => {
		signIn({ organization: false });
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/access-request',
			options: undefined,
		});
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});

	it('still lands on access-request when listing organizations fails', async () => {
		signIn({ organization: false });
		listOrganizations.mockRejectedValueOnce(new Error('offline'));
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/access-request',
			options: undefined,
		});
	});

	it('never org-checks the access-request page itself (no redirect loop)', async () => {
		signIn({ organization: false });
		const { middleware } = await load();
		const to = route('/access-request');

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(listOrganizations).not.toHaveBeenCalled();
	});
});
