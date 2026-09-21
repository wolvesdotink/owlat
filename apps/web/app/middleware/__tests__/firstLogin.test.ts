/**
 * `first-login.global` route guard over the shipped `useAuth`, Nuxt's
 * per-session `useState` and a fake Convex client answering the onboarding
 * query. The once-per-session resolution is asserted by calling the same loaded
 * guard twice, as two navigations in one browser session would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import type { RouteLocationNormalized } from 'vue-router';
import {
	USER,
	authClientMock,
	loadMiddleware,
	resetSession,
	route,
	signIn,
	type Redirect,
} from './harness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Promise<Redirect | undefined>;

const load = (options?: Parameters<typeof loadMiddleware>[1]) =>
	loadMiddleware<Middleware>(() => import('../first-login.global'), options);
const home = route('/dashboard');
const RESOLVED_KEY = 'first-login-resolved';

beforeEach(resetSession);

describe('first-login middleware', () => {
	it('never queries off the trigger paths', async () => {
		signIn();
		const { middleware, convex } = await load();
		const to = route('/dashboard/campaigns');

		await expect(middleware(to, to)).resolves.toBeUndefined();
		expect(convex?.query).not.toHaveBeenCalled();
	});

	it('leaves a signed-out visitor alone', async () => {
		const { middleware, convex } = await load();

		await expect(middleware(home, home)).resolves.toBeUndefined();
		expect(convex?.query).not.toHaveBeenCalled();
	});

	it('routes a member who has never been welcomed to /welcome, and keeps checking', async () => {
		signIn();
		const { middleware, convex, state } = await load();
		convex!.query.mockResolvedValue({ welcomedAt: null });

		await expect(middleware(home, home)).resolves.toEqual({
			redirect: '/welcome',
			options: { replace: true },
		});
		const [query, args] = convex!.query.mock.calls[0]!;
		expect(getFunctionName(query)).toBe(getFunctionName(api.auth.userOnboarding.get));
		expect(args).toEqual({ userId: USER.id });

		// Not resolved: an interrupted navigation to /welcome gets a second chance.
		expect(state.get(RESOLVED_KEY)?.value).toBe(false);
		await expect(middleware(home, home)).resolves.toEqual({
			redirect: '/welcome',
			options: { replace: true },
		});
		expect(convex!.query).toHaveBeenCalledTimes(2);
	});

	it('lets a welcomed member through and asks only once per session', async () => {
		signIn();
		const { middleware, convex, state } = await load();
		convex!.query.mockResolvedValue({ welcomedAt: 1_700_000_000_000 });

		await expect(middleware(home, home)).resolves.toBeUndefined();
		expect(state.get(RESOLVED_KEY)?.value).toBe(true);

		const postbox = route('/dashboard/postbox/inbox');
		await expect(middleware(postbox, postbox)).resolves.toBeUndefined();
		expect(convex!.query).toHaveBeenCalledTimes(1);
	});

	it('fails open on a query error and retries on the next trigger navigation', async () => {
		signIn();
		const { middleware, convex, state } = await load();
		convex!.query.mockRejectedValueOnce(new Error('offline'));
		convex!.query.mockResolvedValueOnce({ welcomedAt: null });

		await expect(middleware(home, home)).resolves.toBeUndefined();
		expect(state.get(RESOLVED_KEY)?.value).toBe(false);

		await expect(middleware(home, home)).resolves.toEqual({
			redirect: '/welcome',
			options: { replace: true },
		});
	});

	it('fails open when no Convex client is installed', async () => {
		signIn();
		const { middleware } = await load({ convex: null });

		await expect(middleware(home, home)).resolves.toBeUndefined();
	});
});
