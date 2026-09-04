/**
 * `platform-admin` route guard over the shipped `useAuth` and a fake Convex
 * client answering the `isPlatformAdmin` probe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import type { RouteLocationNormalized } from 'vue-router';
import {
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
	loadMiddleware<Middleware>(() => import('../platform-admin'), options);
const to = route('/dashboard/admin/instance');

beforeEach(resetSession);

describe('platform-admin middleware', () => {
	it('sends a signed-out visitor to sign in without probing Convex', async () => {
		const { middleware, convex } = await load();

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/auth/login',
			options: undefined,
		});
		expect(convex?.query).not.toHaveBeenCalled();
	});

	it('lets a platform admin through', async () => {
		signIn();
		const { middleware, convex } = await load();
		convex!.query.mockResolvedValue(true);

		await expect(middleware(to, to)).resolves.toBeUndefined();
		const [probe, args] = convex!.query.mock.calls[0]!;
		expect(getFunctionName(probe)).toBe(
			getFunctionName(api.platformAdmin.platformAdmin.isPlatformAdmin)
		);
		expect(args).toEqual({});
	});

	it('sends a signed-in member who is not a platform admin to the dashboard', async () => {
		signIn({ role: 'owner' });
		const { middleware, convex } = await load();
		convex!.query.mockResolvedValue(false);

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/dashboard',
			options: undefined,
		});
	});

	it('fails closed to sign-in when the probe itself fails', async () => {
		signIn();
		const { middleware, convex } = await load();
		convex!.query.mockRejectedValue(new Error('Unauthenticated'));

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/auth/login',
			options: undefined,
		});
	});

	it('fails closed to sign-in when no Convex client is installed', async () => {
		signIn();
		const { middleware } = await load({ convex: null });

		await expect(middleware(to, to)).resolves.toEqual({
			redirect: '/auth/login',
			options: undefined,
		});
	});
});
