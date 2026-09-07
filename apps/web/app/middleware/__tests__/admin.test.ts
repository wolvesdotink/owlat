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

	it('sends a signed-out visitor to sign in without loading the organization', async () => {
		const { middleware } = await load();

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/auth/login',
			options: undefined,
		});
		expect(listMembers).not.toHaveBeenCalled();
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
