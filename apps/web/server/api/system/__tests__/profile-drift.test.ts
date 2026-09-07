import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getActiveProfiles } from '@owlat/shared/featureFlags';

/**
 * Route tests for `GET /api/system/profile-drift` (plan FU4): the durable
 * replacement for per-tab drift memory. Platform-admin session auth mirroring
 * apply-profiles, drift computed here from the updater's APPLIED profiles and
 * Convex's CURRENT resolved flags, and — the point of the route — an
 * unreachable updater answered with a distinct reachable:false body the banner
 * maps to its CLI-fallback variant instead of a thrown error.
 */

const { requirePlatformAdminMock, getInstanceSecretMock, callUpdaterMock, queryMock } = vi.hoisted(
	() => ({
		requirePlatformAdminMock: vi.fn(),
		getInstanceSecretMock: vi.fn(),
		callUpdaterMock: vi.fn(),
		queryMock: vi.fn(),
	})
);

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
	drifted: boolean;
	missingProfiles: string[];
	staleProfiles: string[];
	services: unknown;
	error?: string;
}

async function callRoute(): Promise<RouteResult> {
	const mod = await import('../profile-drift.get');
	const handler = mod.default as unknown as (event: unknown) => Promise<RouteResult>;
	return handler({});
}

function updaterResponse(payload: unknown, ok = true, status = 200) {
	return { ok, status, json: async () => payload };
}

/** The updater's /profile-state body: applied profiles + provider + ps rows. */
function profileState(profiles: string[], deliveryProvider = 'resend', services: unknown = []) {
	return { profiles, deliveryProvider, services };
}

beforeEach(() => {
	requirePlatformAdminMock.mockReset().mockResolvedValue({ query: queryMock });
	getInstanceSecretMock.mockReset().mockReturnValue(INSTANCE_SECRET);
	callUpdaterMock.mockReset().mockResolvedValue(updaterResponse(profileState([])));
	queryMock.mockReset().mockResolvedValue({});

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string; data?: unknown }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data })
	);
});

describe('GET /api/system/profile-drift — auth', () => {
	it('propagates the platform-admin gate before touching the updater', async () => {
		requirePlatformAdminMock.mockRejectedValue(
			Object.assign(new Error('Platform admin access required'), { statusCode: 403 })
		);

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 403 });
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});

	it('forwards the instance secret on a GET to /profile-state', async () => {
		await callRoute();

		expect(callUpdaterMock).toHaveBeenCalledTimes(1);
		const [path, secret, init] = callUpdaterMock.mock.calls[0] as [
			string,
			string,
			{ method: string },
		];
		expect(path).toBe('/profile-state');
		expect(secret).toBe(INSTANCE_SECRET);
		expect(init.method).toBe('GET');
	});
});

describe('GET /api/system/profile-drift — drift computation', () => {
	it.each<[string, Record<string, boolean>, string[], string[], string[]]>([
		[
			'a flag enabled but not applied is missing',
			{ postbox: true },
			[],
			['clamav', 'mta', 'personal-mail'],
			[],
		],
		[
			'a profile applied but no longer required is stale',
			{},
			['clamav', 'external-mail'],
			[],
			['external-mail'],
		],
		[
			'both directions at once',
			{ 'mail.external': true },
			['clamav', 'mta'],
			['external-mail'],
			['mta'],
		],
	])('%s', async (_name, flags, applied, missing, stale) => {
		queryMock.mockResolvedValue(flags);
		callUpdaterMock.mockResolvedValue(updaterResponse(profileState(applied)));

		const result = await callRoute();

		expect(result.reachable).toBe(true);
		expect(result.drifted).toBe(true);
		expect(result.missingProfiles).toEqual(missing);
		expect(result.staleProfiles).toEqual(stale);
	});

	it('reports no drift when the applied set already matches the flags', async () => {
		const flags = { postbox: true };
		queryMock.mockResolvedValue(flags);
		const applied = getActiveProfiles(flags, { deliveryProvider: 'resend' });
		callUpdaterMock.mockResolvedValue(
			updaterResponse(profileState(applied, 'resend', [{ service: 'mta', state: 'running' }]))
		);

		const result = await callRoute();

		expect(result).toEqual({
			reachable: true,
			drifted: false,
			missingProfiles: [],
			staleProfiles: [],
			services: [{ service: 'mta', state: 'running' }],
		});
	});

	it('honours the env-driven deliveryProvider→mta rule from the updater', async () => {
		queryMock.mockResolvedValue({});
		// EMAIL_PROVIDER=mta means the built-in MTA is expected even with no flag
		// asking for it — the same rule /apply-profiles applies when writing.
		callUpdaterMock.mockResolvedValue(updaterResponse(profileState(['clamav'], 'mta')));

		const result = await callRoute();

		expect(result.missingProfiles).toEqual(['mta']);
		expect(result.staleProfiles).toEqual([]);
		expect(result.drifted).toBe(true);
	});

	it('ignores non-string entries in the updater payload', async () => {
		queryMock.mockResolvedValue({});
		callUpdaterMock.mockResolvedValue(
			updaterResponse({ profiles: ['clamav', 7, null], deliveryProvider: 'resend' })
		);

		const result = await callRoute();

		expect(result.drifted).toBe(false);
		expect(result.staleProfiles).toEqual([]);
		expect(result.services).toEqual([]);
	});
});

describe('GET /api/system/profile-drift — updater unreachable', () => {
	it('maps a transport failure to reachable:false instead of throwing', async () => {
		callUpdaterMock.mockRejectedValue(new Error('fetch failed'));

		const result = await callRoute();

		expect(result).toEqual({
			reachable: false,
			drifted: false,
			missingProfiles: [],
			staleProfiles: [],
			services: [],
			error: 'fetch failed',
		});
		// No point asking Convex for flags we cannot compare against.
		expect(queryMock).not.toHaveBeenCalled();
	});

	it('maps a non-2xx updater status to reachable:false with the status', async () => {
		callUpdaterMock.mockResolvedValue(updaterResponse({ error: 'Unauthorized' }, false, 401));

		const result = await callRoute();

		expect(result.reachable).toBe(false);
		expect(result.error).toContain('401');
	});

	it('maps a missing INSTANCE_SECRET to reachable:false, never a 503 throw', async () => {
		getInstanceSecretMock.mockImplementation(() => {
			throw Object.assign(new Error('Drift probe not configured (INSTANCE_SECRET missing)'), {
				statusCode: 503,
			});
		});

		const result = await callRoute();

		expect(result.reachable).toBe(false);
		expect(result.error).toContain('INSTANCE_SECRET');
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});
});

/**
 * The gate itself, not its mock: an unauthenticated request must be refused by
 * the shipped `requirePlatformAdmin` before the route reaches the updater.
 */
describe('GET /api/system/profile-drift — the real platform-admin gate', () => {
	it('rejects an unauthenticated call with 401 before touching the updater', async () => {
		const real = await vi.importActual<typeof import('~~/server/utils/requireAdmin')>(
			'~~/server/utils/requireAdmin'
		);
		requirePlatformAdminMock.mockImplementation(real.requirePlatformAdmin);
		vi.stubGlobal('useRuntimeConfig', () => ({
			public: { convexUrl: 'https://convex.example.com', siteUrl: 'https://owlat.example' },
		}));
		vi.stubGlobal('getHeader', () => undefined);
		const tokenProxy = vi.fn();
		vi.stubGlobal('fetch', tokenProxy);

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 401 });
		expect(tokenProxy).not.toHaveBeenCalled();
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});
});
