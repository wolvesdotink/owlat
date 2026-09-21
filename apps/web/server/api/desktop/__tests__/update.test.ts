import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route tests for the two public desktop-update endpoints.
 *
 * The manifest route is a wire contract with Tauri's Rust updater, so the three
 * things asserted here are the three things that contract is made of: a hit is
 * passed through BYTE-FOR-BYTE with a JSON content type, a miss is `204` with no
 * body (Tauri's "no update"), and a malformed path segment never reaches Convex.
 * The policy route doubles as the capability probe, so its 404-without-Convex
 * behaviour is what makes an older server fall back to GitHub.
 *
 * h3's auto-imports and the Convex client are stubbed; no network, no Nuxt.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

// The route constructs the client with `new`, so the mock must be a real class.
vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		query = queryMock;
	},
}));

vi.mock('@owlat/api', () => ({
	api: {
		desktop: {
			updates: {
				manifestForClient: 'manifestForClient',
				getPolicySummary: 'getPolicySummary',
			},
		},
	},
}));

const MANIFEST = JSON.stringify({
	version: '0.4.7',
	platforms: {
		'darwin-universal': {
			url: 'https://github.com/wolvesdotink/owlat/releases/download/v0.4.7/owlat.app.tar.gz',
			signature: 'dW50cnVzdGVk',
		},
	},
});

let params: Record<string, string> = {};
let convexUrl = 'https://convex.example.com';
const responseHeaders: Record<string, string> = {};
let responseStatus: number | null = null;

interface HttpError {
	statusCode: number;
	statusMessage: string;
}

beforeEach(() => {
	queryMock.mockReset().mockResolvedValue(null);
	params = { target: 'darwin', arch: 'aarch64', current: '0.4.6' };
	convexUrl = 'https://convex.example.com';
	responseStatus = null;
	for (const key of Object.keys(responseHeaders)) delete responseHeaders[key];

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => params[name]);
	vi.stubGlobal('useRuntimeConfig', () => ({ public: { convexUrl } }));
	vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: string) => {
		responseHeaders[name] = value;
	});
	vi.stubGlobal('setResponseStatus', (_event: unknown, status: number) => {
		responseStatus = status;
	});
	vi.stubGlobal('createError', (opts: HttpError) => {
		const err = new Error(opts.statusMessage) as Error & HttpError;
		err.statusCode = opts.statusCode;
		err.statusMessage = opts.statusMessage;
		return err;
	});
});

async function callManifestRoute(): Promise<string | null> {
	const mod = await import('../update/[target]/[arch]/[current].get');
	const handler = mod.default as unknown as (event: unknown) => Promise<string | null>;
	return handler({});
}

async function callPolicyRoute(): Promise<unknown> {
	const mod = await import('../update-policy.get');
	const handler = mod.default as unknown as (event: unknown) => Promise<unknown>;
	return handler({});
}

describe('GET /api/desktop/update/:target/:arch/:current', () => {
	it('serves the cached manifest verbatim as JSON', async () => {
		queryMock.mockResolvedValue({ manifest: MANIFEST, version: '0.4.7' });

		const body = await callManifestRoute();

		expect(body).toBe(MANIFEST);
		expect(responseHeaders['Content-Type']).toBe('application/json');
		expect(responseHeaders['Cache-Control']).toBe('no-store');
		expect(queryMock).toHaveBeenCalledWith('manifestForClient', {
			target: 'darwin',
			arch: 'aarch64',
			currentVersion: '0.4.6',
		});
	});

	it('answers 204 with no body when the policy offers nothing', async () => {
		queryMock.mockResolvedValue(null);

		const body = await callManifestRoute();

		expect(body).toBeNull();
		expect(responseStatus).toBe(204);
		expect(responseHeaders['Content-Type']).toBeUndefined();
	});

	it('400s on a malformed version segment without reaching Convex', async () => {
		for (const current of ['dev', '0.4', 'latest', '0.4.6/../..', '']) {
			params = { target: 'darwin', arch: 'aarch64', current };
			await expect(callManifestRoute()).rejects.toMatchObject({ statusCode: 400 });
		}
		expect(queryMock).not.toHaveBeenCalled();
	});

	it('400s on a malformed target or arch segment', async () => {
		params = { target: 'darwin/../x', arch: 'aarch64', current: '0.4.6' };
		await expect(callManifestRoute()).rejects.toMatchObject({ statusCode: 400 });

		params = { target: 'darwin', arch: 'AARCH64!', current: '0.4.6' };
		await expect(callManifestRoute()).rejects.toMatchObject({ statusCode: 400 });

		expect(queryMock).not.toHaveBeenCalled();
	});

	it('accepts a pre-release client version', async () => {
		params = { target: 'linux', arch: 'x86_64', current: '0.5.0-rc.1' };
		queryMock.mockResolvedValue({ manifest: MANIFEST, version: '0.5.0' });

		await expect(callManifestRoute()).resolves.toBe(MANIFEST);
	});

	it('404s when the deployment has no Convex URL', async () => {
		convexUrl = '';
		await expect(callManifestRoute()).rejects.toMatchObject({ statusCode: 404 });
	});
});

describe('GET /api/desktop/update-policy', () => {
	it('returns the policy summary uncached', async () => {
		const summary = {
			mode: 'latest',
			channel: 'stable',
			pinnedVersion: null,
			requiredVersion: null,
			deferHours: 0,
			latestVersion: '0.4.7',
			latestPublishedAt: 1_760_000_000_000,
			checkedAt: 1_760_000_100_000,
		};
		queryMock.mockResolvedValue(summary);

		await expect(callPolicyRoute()).resolves.toEqual(summary);
		expect(responseHeaders['Cache-Control']).toBe('no-store');
		expect(queryMock).toHaveBeenCalledWith('getPolicySummary', {});
	});

	it('404s when the deployment has no Convex URL, so the app falls back to GitHub', async () => {
		convexUrl = '';
		await expect(callPolicyRoute()).rejects.toMatchObject({ statusCode: 404 });
	});
});
