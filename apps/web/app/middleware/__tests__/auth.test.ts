/**
 * `auth` route guard over the shipped `useAuth` / `useActiveMemberRole` /
 * `useOrganization` chain and a fake better-auth session. The organization
 * auto-activation path runs the real `setActive` (session refetch, active-org
 * sync) against the mocked auth client.
 *
 * The guard decides on the session alone. It must not wait for the member
 * role (only `admin` does) and nothing on the boot path may load the member or
 * invitation lists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import {
	ORGANIZATION,
	authClientMock,
	enterDesktopRuntime,
	getActiveMember,
	leaveDesktopRuntime,
	listInvitations,
	listMembers,
	listOrganizations,
	loadMiddleware,
	resetSession,
	route,
	session,
	setActiveOrganization,
	signIn,
	useActiveOrganization,
	useListOrganizations,
	type Redirect,
} from '~/__tests__/middlewareHarness';

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

	it('does not build the organization stores before redirecting', async () => {
		// Constructing better-auth's organization hooks IS the request: it fetches
		// the full organization and the organization list. A signed-out visitor
		// would only collect 401s from both on the way to the login redirect, so
		// the guard must decide first and build the context afterwards.
		const { middleware } = await load();
		const to = route('/dashboard');

		await middleware(to, to);

		expect(useActiveOrganization).not.toHaveBeenCalled();
		expect(useListOrganizations).not.toHaveBeenCalled();
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

	it('does not wait for the member role', async () => {
		signIn({ role: 'owner' });
		// A role lookup that never answers: the guard must not care.
		getActiveMember.mockImplementationOnce(() => new Promise(() => undefined));
		const { middleware } = await load();
		const to = route('/dashboard');

		const decision = await Promise.race([
			middleware(to, to),
			new Promise((resolve) => setTimeout(() => resolve('WAITED'), 200)),
		]);

		expect(decision).toBeUndefined();
		// …but it has started the lookup, so the role is on its way.
		expect(getActiveMember).toHaveBeenCalledOnce();
	});

	it('does not wait for the full organization request either', async () => {
		signIn();
		// better-auth's full-organization request has not answered.
		session.organizations.value = [];
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(listOrganizations).not.toHaveBeenCalled();
	});

	it('lets an editor through: the role does not gate ordinary pages', async () => {
		signIn({ role: 'member' });
		const { middleware } = await load();
		const to = route('/dashboard/campaigns');

		await expect(middleware(to, to)).resolves.toBeUndefined();
	});

	it('loads neither the member nor the invitation list on boot', async () => {
		signIn({ role: 'owner' });
		const { middleware } = await load();
		const to = route('/dashboard');

		await middleware(to, to);
		// What the dashboard shell builds once the guard lets it render.
		const { isLoading, role } = useOrganizationContext();
		const { isAdmin } = usePermissions();
		await waitForLoaded(isLoading);

		expect(role.value).toBe('owner');
		expect(isAdmin.value).toBe(true);
		expect(getActiveMember).toHaveBeenCalledOnce();
		expect(listMembers).not.toHaveBeenCalled();
		expect(listInvitations).not.toHaveBeenCalled();
	});

	it('still hands a roster page its list before the full organization arrives', async () => {
		signIn({ role: 'owner' });
		session.organizations.value = [];
		const { middleware } = await load();
		const to = route('/dashboard/admin/team');

		await middleware(to, to);
		await useOrganization().fetchMembers();

		expect(listMembers).toHaveBeenCalledWith({ query: { organizationId: ORGANIZATION.id } });
		expect(listInvitations).toHaveBeenCalledWith({ query: { organizationId: ORGANIZATION.id } });
	});

	it('activates the first organization the member belongs to when none is active', async () => {
		signIn({ organization: false });
		session.organizations.value = [ORGANIZATION];
		session.members.value = [{ userId: 'user-1', role: 'admin' }];
		const { middleware } = await load();
		const to = route('/dashboard');

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(setActiveOrganization).toHaveBeenCalledWith({ organizationId: ORGANIZATION.id });
		expect(session.activeOrganizationId.value).toBe(ORGANIZATION.id);
		// The role follows the new session organization; the lists stay unloaded.
		await waitForLoaded(useOrganizationContext().isLoading);
		expect(usePermissions().role.value).toBe('admin');
		expect(listMembers).not.toHaveBeenCalled();
		expect(listInvitations).not.toHaveBeenCalled();
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
