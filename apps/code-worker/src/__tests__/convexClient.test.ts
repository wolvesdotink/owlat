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
		delete process.env['CODE_WORKER_CONVEX_KEY'];
	});

	it('authenticates the client with the deployment admin key', async () => {
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		expect(mocks.ctor).toHaveBeenCalledWith('http://convex:3210');
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('admin-key-abc123');
	});

	it('prefers the scoped CODE_WORKER_CONVEX_KEY over the admin key (least-privilege seam)', async () => {
		process.env['CODE_WORKER_CONVEX_KEY'] = 'scoped-key-xyz789';
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		// The scoped key wins; the broad admin key is never presented.
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('scoped-key-xyz789');
		expect(mocks.setAdminAuth).not.toHaveBeenCalledWith('admin-key-abc123');
	});

	it('falls back to the admin key when the scoped key is an empty string (compose default)', async () => {
		// Compose sets `CODE_WORKER_CONVEX_KEY: ${CODE_WORKER_CONVEX_KEY:-}`, so an
		// install that never defines the scoped key gets '' — not undefined. The
		// nullish-coalescing form kept '' and crashed at startup; ensure the empty
		// string is treated as unset and the admin key is used instead.
		process.env['CODE_WORKER_CONVEX_KEY'] = '';
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('admin-key-abc123');
	});

	it('treats a whitespace-only scoped key as unset and falls back to the admin key', async () => {
		process.env['CODE_WORKER_CONVEX_KEY'] = '   ';
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('admin-key-abc123');
	});

	it('runs on the scoped key alone with no admin key in the environment', async () => {
		delete process.env['CONVEX_ADMIN_KEY'];
		process.env['CODE_WORKER_CONVEX_KEY'] = 'scoped-key-only';
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('scoped-key-only');
	});

	it('runs in proxy-token-only mode: URL points at the fn-proxy, token is the proxy secret', async () => {
		// The composed hardened deployment (apps/convex-fn-proxy): CONVEX_URL is the
		// proxy, CODE_WORKER_CONVEX_KEY is the proxy token, and NO admin key is in
		// the container. setAdminAuth sends the token as `Authorization: Convex
		// <token>`, which the proxy validates+strips and replaces with the admin key.
		delete process.env['CONVEX_ADMIN_KEY'];
		process.env['CONVEX_URL'] = 'http://convex-fn-proxy:3220';
		process.env['CODE_WORKER_CONVEX_KEY'] = 'proxy-token-secret';
		const { getConvexClient } = await import('../convexClient.js');
		getConvexClient();
		expect(mocks.ctor).toHaveBeenCalledWith('http://convex-fn-proxy:3220');
		expect(mocks.setAdminAuth).toHaveBeenCalledWith('proxy-token-secret');
		expect(mocks.setAdminAuth).not.toHaveBeenCalledWith('admin-key-abc123');
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

	it('throws when neither Convex key is set (would otherwise hit auth-less internal calls)', async () => {
		delete process.env['CONVEX_ADMIN_KEY'];
		delete process.env['CODE_WORKER_CONVEX_KEY'];
		const { getConvexClient } = await import('../convexClient.js');
		expect(() => getConvexClient()).toThrow(
			'CODE_WORKER_CONVEX_KEY or CONVEX_ADMIN_KEY environment variable is required'
		);
	});
});
