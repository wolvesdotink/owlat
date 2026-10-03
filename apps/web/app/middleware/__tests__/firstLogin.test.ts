/**
 * `first-login.global` route guard over the shipped `useAuth`, Nuxt's
 * per-session `useState` and a fake Convex client answering the onboarding
 * query. The once-per-session resolution is asserted by calling the same loaded
 * guard twice, as two navigations in one browser session would.
 *
 * The guard never blocks: it returns before the onboarding query settles and
 * redirects through the router afterwards, so the suite drives a fake router
 * (current route + `afterEach` hooks) and flushes the query's promise chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import type { RouteLocationNormalized } from 'vue-router';
import { TRANSIENT_RETRY_LIMIT } from '~/lib/queryRetry';
import {
	USER,
	authClientMock,
	loadMiddleware,
	resetSession,
	route,
	signIn,
	type Redirect,
} from '~/__tests__/middlewareHarness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Promise<Redirect | undefined>;

const home = route('/dashboard');
const RESOLVED_KEY = 'first-login-resolved';
const CACHE_KEY = `owlat:welcomed:${USER.id}`;

/** The router the guard captures: the settled route and the post-navigation hooks. */
function createFakeRouter(initialPath: string) {
	const currentRoute = ref({ path: initialPath, fullPath: initialPath });
	const hooks = new Set<() => void>();
	return {
		currentRoute,
		replace: vi.fn(async (_to: string) => undefined),
		afterEach: (hook: () => void) => {
			hooks.add(hook);
			return () => hooks.delete(hook);
		},
		/** A navigation finished on `path`, as vue-router reports it. */
		settle(path: string) {
			currentRoute.value = { path, fullPath: path };
			for (const hook of hooks) hook();
		},
		hookCount: () => hooks.size,
	};
}

async function load(options: Parameters<typeof loadMiddleware>[1] & { currentPath?: string } = {}) {
	const loaded = await loadMiddleware<Middleware>(() => import('../first-login.global'), options);
	const router = createFakeRouter(options.currentPath ?? '/dashboard');
	vi.stubGlobal('useRouter', () => router);
	return { ...loaded, router };
}

/** Let the background query's promise chain run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	resetSession();
	localStorage.clear();
});

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

	describe('with a cached welcomed state', () => {
		it('skips the query and resolves the session', async () => {
			signIn();
			localStorage.setItem(CACHE_KEY, '1');
			const { middleware, convex, router, state } = await load();

			await expect(middleware(home, home)).resolves.toBeUndefined();
			await flush();
			expect(convex!.query).not.toHaveBeenCalled();
			expect(router.replace).not.toHaveBeenCalled();
			expect(state.get(RESOLVED_KEY)?.value).toBe(true);
		});

		it('does not count another user’s cache entry', async () => {
			signIn();
			localStorage.setItem('owlat:welcomed:someone-else', '1');
			const { middleware, convex } = await load();
			convex!.query.mockResolvedValue({ welcomedAt: 1_700_000_000_000 });

			await middleware(home, home);
			expect(convex!.query).toHaveBeenCalledTimes(1);
		});
	});

	describe('without a cached state', () => {
		it('does not wait for the query before letting the navigation through', async () => {
			signIn();
			const { middleware, convex, router } = await load();
			const answer = deferred<{ welcomedAt: number | null }>();
			convex!.query.mockReturnValue(answer.promise);

			// The guard settles while the query is still unanswered.
			await expect(middleware(home, home)).resolves.toBeUndefined();
			const [query, args] = convex!.query.mock.calls[0]!;
			expect(getFunctionName(query)).toBe(getFunctionName(api.auth.userOnboarding.get));
			expect(args).toEqual({ userId: USER.id });
			expect(router.replace).not.toHaveBeenCalled();

			answer.resolve({ welcomedAt: null });
			await flush();
			expect(router.replace).toHaveBeenCalledWith('/welcome');
		});

		it('routes a member who has never been welcomed to /welcome, and keeps checking', async () => {
			signIn();
			const { middleware, convex, router, state } = await load();
			convex!.query.mockResolvedValue({ welcomedAt: null });

			await middleware(home, home);
			await flush();
			expect(router.replace).toHaveBeenCalledTimes(1);
			expect(router.replace).toHaveBeenCalledWith('/welcome');
			expect(localStorage.getItem(CACHE_KEY)).toBeNull();

			// Not resolved: an interrupted redirect to /welcome gets a second chance.
			expect(state.get(RESOLVED_KEY)?.value).toBe(false);
			await middleware(home, home);
			await flush();
			expect(convex!.query).toHaveBeenCalledTimes(2);
			expect(router.replace).toHaveBeenCalledTimes(2);
		});

		it('waits for a still-running navigation before redirecting', async () => {
			signIn();
			// Cold boot: the router has not committed the first route yet.
			const { middleware, convex, router } = await load({ currentPath: '/' });
			convex!.query.mockResolvedValue({ welcomedAt: null });

			await middleware(home, home);
			await flush();
			expect(router.replace).not.toHaveBeenCalled();

			router.settle('/dashboard');
			expect(router.replace).toHaveBeenCalledWith('/welcome');
			expect(router.hookCount()).toBe(0);
		});

		it('does not redirect once the member has left the trigger paths', async () => {
			signIn();
			const { middleware, convex, router } = await load({ currentPath: '/' });
			convex!.query.mockResolvedValue({ welcomedAt: null });

			await middleware(home, home);
			await flush();
			router.settle('/dashboard/campaigns');
			expect(router.replace).not.toHaveBeenCalled();
		});

		it('does not redirect when the welcome screen was reached first', async () => {
			signIn();
			const { middleware, convex, router, state } = await load();
			const answer = deferred<{ welcomedAt: number | null }>();
			convex!.query.mockReturnValue(answer.promise);

			await middleware(home, home);
			// welcome.vue flips the session flag on setup.
			state.get(RESOLVED_KEY)!.value = true;
			answer.resolve({ welcomedAt: null });
			await flush();
			expect(router.replace).not.toHaveBeenCalled();
		});

		it('shares one query between trigger navigations while it is in flight', async () => {
			signIn();
			const { middleware, convex } = await load();
			const answer = deferred<{ welcomedAt: number | null }>();
			convex!.query.mockReturnValue(answer.promise);

			await middleware(home, home);
			const postbox = route('/dashboard/postbox/inbox');
			await middleware(postbox, postbox);
			expect(convex!.query).toHaveBeenCalledTimes(1);

			answer.resolve({ welcomedAt: 1_700_000_000_000 });
			await flush();
		});

		it('lets a welcomed member through, caches it and asks only once per session', async () => {
			signIn();
			const { middleware, convex, router, state } = await load();
			convex!.query.mockResolvedValue({ welcomedAt: 1_700_000_000_000 });

			await expect(middleware(home, home)).resolves.toBeUndefined();
			await flush();
			expect(state.get(RESOLVED_KEY)?.value).toBe(true);
			expect(localStorage.getItem(CACHE_KEY)).toBe('1');
			expect(router.replace).not.toHaveBeenCalled();

			const postbox = route('/dashboard/postbox/inbox');
			await expect(middleware(postbox, postbox)).resolves.toBeUndefined();
			expect(convex!.query).toHaveBeenCalledTimes(1);
		});

		it('redirects at once when the navigation settled while the answer was pending', async () => {
			signIn();
			const { middleware, convex, router } = await load({ currentPath: '/' });
			const answer = deferred<{ welcomedAt: number | null }>();
			convex!.query.mockReturnValue(answer.promise);

			await middleware(home, home);
			// The dashboard finished loading and the member opened the Postbox
			// before the answer came back.
			router.settle('/dashboard');
			router.settle('/dashboard/postbox/inbox');

			answer.resolve({ welcomedAt: null });
			await flush();
			expect(router.replace).toHaveBeenCalledWith('/welcome');
			expect(router.hookCount()).toBe(0);
		});

		describe('right after sign-in, while Convex auth settles', () => {
			it('asks only once the server has confirmed the session', async () => {
				signIn();
				const { middleware, convex, router, convexAuth } = await load({
					convexAuth: 'pending',
				});
				convex!.query.mockResolvedValue({ welcomedAt: null });

				await expect(middleware(home, home)).resolves.toBeUndefined();
				await flush();
				expect(convex!.query).not.toHaveBeenCalled();

				convexAuth.reportConvexAuth(true);
				await flush();
				expect(convex!.query).toHaveBeenCalledTimes(1);
				expect(router.replace).toHaveBeenCalledWith('/welcome');
			});

			it('fails open when Convex auth does not come up, and asks again next time', async () => {
				signIn();
				const { middleware, convex, router, state, convexAuth } = await load({
					convexAuth: 'pending',
				});
				convex!.query.mockResolvedValue({ welcomedAt: null });

				await middleware(home, home);
				convexAuth.reportConvexAuth(false);
				await flush();
				expect(convex!.query).not.toHaveBeenCalled();
				expect(router.replace).not.toHaveBeenCalled();
				expect(state.get(RESOLVED_KEY)?.value).toBe(false);

				convexAuth.markConvexAuthPending();
				await middleware(home, home);
				convexAuth.reportConvexAuth(true);
				await flush();
				expect(router.replace).toHaveBeenCalledWith('/welcome');
			});
		});

		describe('when the query fails', () => {
			beforeEach(() => {
				vi.useFakeTimers();
			});
			afterEach(() => {
				vi.useRealTimers();
			});

			it('retries in the background and redirects once an attempt answers', async () => {
				signIn();
				const { middleware, convex, router } = await load();
				convex!.query.mockRejectedValueOnce(new Error('Not authenticated'));
				convex!.query.mockResolvedValueOnce({ welcomedAt: null });

				await expect(middleware(home, home)).resolves.toBeUndefined();
				await vi.advanceTimersByTimeAsync(0);
				expect(convex!.query).toHaveBeenCalledTimes(1);
				expect(router.replace).not.toHaveBeenCalled();

				// No further navigation: the same check tries again on its own.
				await vi.advanceTimersByTimeAsync(10_000);
				expect(convex!.query).toHaveBeenCalledTimes(2);
				expect(router.replace).toHaveBeenCalledWith('/welcome');
			});

			it('caches a welcomed answer that arrives on a retry', async () => {
				signIn();
				const { middleware, convex, router, state } = await load();
				convex!.query.mockRejectedValueOnce(new Error('Not authenticated'));
				convex!.query.mockResolvedValueOnce({ welcomedAt: 1_700_000_000_000 });

				await middleware(home, home);
				await vi.advanceTimersByTimeAsync(10_000);
				expect(router.replace).not.toHaveBeenCalled();
				expect(localStorage.getItem(CACHE_KEY)).toBe('1');
				expect(state.get(RESOLVED_KEY)?.value).toBe(true);
			});

			it('fails open once the retries are spent, and asks again on the next trigger navigation', async () => {
				signIn();
				const { middleware, convex, router, state } = await load();
				convex!.query.mockRejectedValue(new Error('offline'));

				await expect(middleware(home, home)).resolves.toBeUndefined();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(convex!.query).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT + 1);
				expect(router.replace).not.toHaveBeenCalled();
				expect(state.get(RESOLVED_KEY)?.value).toBe(false);

				convex!.query.mockResolvedValue({ welcomedAt: null });
				await middleware(home, home);
				await vi.advanceTimersByTimeAsync(0);
				expect(router.replace).toHaveBeenCalledWith('/welcome');
			});

			it('stops retrying once the welcome screen has been reached', async () => {
				signIn();
				const { middleware, convex, router, state } = await load();
				convex!.query.mockRejectedValue(new Error('Not authenticated'));

				await middleware(home, home);
				await vi.advanceTimersByTimeAsync(0);
				state.get(RESOLVED_KEY)!.value = true;
				await vi.advanceTimersByTimeAsync(60_000);
				expect(convex!.query).toHaveBeenCalledTimes(1);
				expect(router.replace).not.toHaveBeenCalled();
			});
		});

		it('fails open when no Convex client is installed', async () => {
			signIn();
			const { middleware, router } = await load({ convex: null });

			await expect(middleware(home, home)).resolves.toBeUndefined();
			await flush();
			expect(router.replace).not.toHaveBeenCalled();
		});
	});
});
