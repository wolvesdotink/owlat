import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * convexClient.ts builds a single cached ConvexHttpClient. The worker has no
 * user session, so it must authenticate with the deployment admin key (exactly
 * like apps/imap and apps/mail-sync) — otherwise the internalQuery it polls
 * (`getNextQueued`) and the internalMutations it drives are unreachable.
 *
 * We mock `convex/browser` so no deployment is touched and assert that
 * `setAdminAuth` is invoked with the env key, and that both required env vars
 * are enforced. The module caches its client, so each test resets the module
 * registry and re-imports to get a clean singleton + fresh env read.
 */

const mocks = vi.hoisted(() => {
	const setAdminAuth = vi.fn();
	const ctor = vi.fn();
	return { setAdminAuth, ctor };
});

vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		setAdminAuth = mocks.setAdminAuth;
		constructor(url: string) {
			mocks.ctor(url);
		}
	},
}));

describe('code-worker getConvexClient', () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.setAdminAuth.mockClear();
		mocks.ctor.mockClear();
		process.env['CONVEX_URL'] = 'http://convex:3210';
		process.env['CONVEX_ADMIN_KEY'] = 'admin-key-abc123';
	});

	afterEach(() => {
		delete process.env['CONVEX_URL'];
		delete process.env['CONVEX_ADMIN_KEY'];
	});

	it('authenticates the client with the deployment admin key', async () => {
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		expect(mocks.ctor).toHaveBeenCalledWith('http://convex:3210');
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('admin-key-abc123');
	});

	it('caches the client across calls (constructed + authed once)', async () => {
		const { getConvexClient } = await import('../convexClient.js');
		const a = getConvexClient();
		const b = getConvexClient();
		expect(a).toBe(b);
		expect(mocks.ctor).toHaveBeenCalledTimes(1);
		expect(mocks.setAdminAuth).toHaveBeenCalledTimes(1);
	});

	it('throws when CONVEX_URL is missing', async () => {
		delete process.env['CONVEX_URL'];
		const { getConvexClient } = await import('../convexClient.js');
		expect(() => getConvexClient()).toThrow('CONVEX_URL environment variable is required');
	});

	it('throws when CONVEX_ADMIN_KEY is missing (would otherwise hit auth-less internal calls)', async () => {
		delete process.env['CONVEX_ADMIN_KEY'];
		const { getConvexClient } = await import('../convexClient.js');
		expect(() => getConvexClient()).toThrow('CONVEX_ADMIN_KEY environment variable is required');
	});
});
