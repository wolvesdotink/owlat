import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route tests for `POST /api/system/port-checks`.
 *
 * Three properties matter here. The platform-admin gate runs BEFORE anything
 * reaches the updater, because the endpoint behind it opens connections to
 * third parties. The request body never reaches the updater — the probe list
 * comes from the host `.env`, which is what stops the route being a port
 * scanner someone can aim. And an updater that is absent or refuses answers
 * `reachable: false`, not a thrown error: an instance without the sidecar
 * cannot run these probes at all, and the card has a branch that says so.
 */

const { requirePlatformAdminMock, getInstanceSecretMock, callUpdaterMock } = vi.hoisted(() => ({
	requirePlatformAdminMock: vi.fn(),
	getInstanceSecretMock: vi.fn(),
	callUpdaterMock: vi.fn(),
}));

vi.mock('~~/server/utils/requireAdmin', () => ({
	requirePlatformAdmin: requirePlatformAdminMock,
}));
vi.mock('~~/server/utils/updater', () => ({
	getInstanceSecret: getInstanceSecretMock,
	callUpdater: callUpdaterMock,
}));

const INSTANCE_SECRET = 's'.repeat(64);

interface RouteResult {
	reachable: boolean;
	verdict?: string;
	checks?: unknown;
	error?: string;
}

async function callRoute(): Promise<RouteResult> {
	const mod = await import('../port-checks.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<RouteResult>;
	return handler({});
}

function updaterResponse(payload: unknown, ok = true, status = 200) {
	return { ok, status, json: async () => payload };
}

beforeEach(() => {
	vi.clearAllMocks();
	// Nitro's auto-imports are not present outside the built server.
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	requirePlatformAdminMock.mockResolvedValue({});
	getInstanceSecretMock.mockReturnValue(INSTANCE_SECRET);
});

describe('auth', () => {
	it('runs the platform-admin gate before touching the updater', async () => {
		requirePlatformAdminMock.mockRejectedValue(new Error('Forbidden'));

		await expect(callRoute()).rejects.toThrow('Forbidden');
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});

	it('reports an unconfigured instance secret as unreachable, not as a 500', async () => {
		getInstanceSecretMock.mockImplementation(() => {
			throw new Error('Port checks not configured (INSTANCE_SECRET missing)');
		});

		const result = await callRoute();
		expect(result).toMatchObject({ reachable: false });
		expect(result.error).toContain('INSTANCE_SECRET');
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});
});

describe('proxying', () => {
	it('POSTs to the updater with the instance secret and no caller-supplied target', async () => {
		callUpdaterMock.mockResolvedValue(updaterResponse({ verdict: 'ok', checks: [] }));

		const result = await callRoute();

		expect(callUpdaterMock).toHaveBeenCalledWith(
			'/port-checks',
			INSTANCE_SECRET,
			expect.objectContaining({ method: 'POST' })
		);
		const [, , init] = callUpdaterMock.mock.calls[0]!;
		expect((init as { body?: unknown }).body).toBeUndefined();
		expect(result).toMatchObject({ reachable: true, verdict: 'ok' });
	});

	it('passes the updater verdict and rows straight through', async () => {
		const checks = [{ id: 'outbound-imaps', status: 'blocked', relevance: 'required' }];
		callUpdaterMock.mockResolvedValue(updaterResponse({ verdict: 'degraded', checks }));

		const result = await callRoute();

		expect(result.verdict).toBe('degraded');
		expect(result.checks).toEqual(checks);
	});

	/**
	 * A sidecar that ANSWERS and refuses is not a missing sidecar. Reporting its
	 * rate limit as `reachable: false` sent an operator who pressed the button
	 * three times in a minute to go and check whether the container was running.
	 */
	it('keeps a refusing updater reachable, with its reason', async () => {
		callUpdaterMock.mockResolvedValue(
			updaterResponse({ error: 'Too many port-check requests. Try again in a minute.' }, false, 429)
		);

		const result = await callRoute();

		expect(result.reachable).toBe(true);
		expect(result.error).toContain('Too many port-check requests');
		expect(result.checks).toBeUndefined();
	});

	it('maps a sidecar that never answered to unreachable rather than throwing', async () => {
		callUpdaterMock.mockRejectedValue(new Error('connect ECONNREFUSED 172.20.0.9:3200'));

		const result = await callRoute();

		expect(result.reachable).toBe(false);
		expect(result.error).toContain('ECONNREFUSED');
	});
});
