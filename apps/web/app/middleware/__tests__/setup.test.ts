/**
 * `setup.global` route guard: while the `setupMode` runtime flag is live every
 * route redirects to the wizard except the allowlisted prefixes. The flag only
 * clears on a web-container restart, so `/auth/*` has to stay reachable or the
 * operator who just finished the wizard is bounced back to `/setup` forever.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import { authClientMock, loadMiddleware, route, type Redirect } from './harness';

vi.mock('~/lib/auth-client', () => authClientMock());

type Middleware = (
	to: RouteLocationNormalized,
	from: RouteLocationNormalized
) => Redirect | undefined;
type SetupModule = typeof import('../setup.global');

async function load(setupMode: boolean) {
	let mod!: SetupModule;
	const loaded = await loadMiddleware<Middleware>(
		async () => {
			mod = await import('../setup.global');
			return mod;
		},
		{ runtimeConfig: { public: { setupMode } } }
	);
	return { ...loaded, mod };
}

describe('setup-mode middleware', () => {
	it('is inert once setup mode is off', async () => {
		const { middleware } = await load(false);
		const to = route('/dashboard');

		expect(middleware(to, to)).toBeUndefined();
	});

	it('sends every product route to the wizard while setup mode is on', async () => {
		const { middleware } = await load(true);

		for (const path of ['/', '/dashboard', '/dashboard/campaigns', '/pricing']) {
			const to = route(path);
			expect(middleware(to, to)).toEqual({ redirect: '/setup', options: { replace: true } });
		}
	});

	it('lets the operator reach sign-in after apply, before the restart clears the flag', async () => {
		const { middleware } = await load(true);

		for (const path of ['/auth/login', '/auth/forgot-password']) {
			const to = route(path);
			expect(middleware(to, to)).toBeUndefined();
		}
	});

	it('leaves the wizard, its API and its assets alone', async () => {
		const { middleware } = await load(true);

		for (const path of [
			'/setup',
			'/setup/admin',
			'/api/setup/apply',
			'/_nuxt/entry.js',
			'/favicon.ico',
		]) {
			const to = route(path);
			expect(middleware(to, to)).toBeUndefined();
		}
	});

	it('exposes the allowlist the guard decides on', async () => {
		const { mod } = await load(true);

		expect(mod.isSetupAllowlisted('/auth/login?postSetup=1')).toBe(true);
		expect(mod.isSetupAllowlisted('/dashboard')).toBe(false);
		expect(mod.SETUP_ALLOWLIST_PREFIXES).toContain('/auth');
	});
});
