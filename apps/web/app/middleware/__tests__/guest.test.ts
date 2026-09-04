/**
 * `guest` route guard (login / register pages) over the shipped `useAuth` and
 * the real `safeRedirect`, so the open-redirect filter is the one that ships.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import {
	authClientMock,
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

const load = () => loadMiddleware<Middleware>(() => import('../guest'));

beforeEach(resetSession);

describe('guest middleware', () => {
	it('lets a signed-out visitor see the login page', async () => {
		const { middleware } = await load();
		const to = route('/auth/login');

		await expect(middleware(to, to)).resolves.toBeUndefined();
	});

	it('sends a signed-in member to the dashboard', async () => {
		signIn();
		const { middleware } = await load();
		const to = route('/auth/login');

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/dashboard',
			options: undefined,
		});
	});

	it('honours a same-origin redirect target', async () => {
		signIn();
		const { middleware } = await load();
		const to = route('/auth/login', { query: { redirect: '/dashboard/inbox?folder=archived' } });

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/dashboard/inbox?folder=archived',
			options: undefined,
		});
	});

	it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
		'refuses the off-origin redirect %s and falls back to the dashboard',
		async (redirect) => {
			signIn();
			const { middleware } = await load();
			const to = route('/auth/login', { query: { redirect } });

			await expect(middleware(to, to)).resolves.toEqual({
				redirect: '/dashboard',
				options: undefined,
			});
		}
	);

	it('waits for a pending session and then decides on its outcome', async () => {
		session.pending.value = true;
		const { middleware } = await load();
		const to = route('/auth/login');

		let settled = false;
		const decision = middleware(to, to).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		signIn();
		session.pending.value = false;
		await expect(decision).resolves.toEqual({ redirect: '/dashboard', options: undefined });
	});
});
