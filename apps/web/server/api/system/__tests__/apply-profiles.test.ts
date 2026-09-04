import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route tests for `POST /api/system/apply-profiles` (plan D4): platform-admin
 * session auth mirroring /api/system/update, body-shape validation, and the
 * proxy to the updater sidecar's /apply-profiles — forwarding flags (never
 * profile strings) with the instance secret, surfacing updater failures as
 * 502 so the UI can branch into its CLI fallback.
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

let body: unknown;

interface RouteResult {
	success?: boolean;
	profiles?: string[];
	services?: unknown;
}

async function callRoute(): Promise<RouteResult> {
	const mod = await import('../apply-profiles.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<RouteResult>;
	return handler({});
}

function updaterResponse(ok: boolean, payload: unknown) {
	return { ok, json: async () => payload };
}

beforeEach(() => {
	requirePlatformAdminMock.mockReset().mockResolvedValue({});
	getInstanceSecretMock.mockReset().mockReturnValue(INSTANCE_SECRET);
	callUpdaterMock
		.mockReset()
		.mockResolvedValue(
			updaterResponse(true, { success: true, profiles: ['external-mail'], services: [] })
		);
	body = { flags: { 'mail.external': true, ai: false } };

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string; data?: unknown }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data })
	);
});

describe('POST /api/system/apply-profiles — auth', () => {
	it('propagates the platform-admin gate before touching the updater', async () => {
		requirePlatformAdminMock.mockRejectedValue(
			Object.assign(new Error('Platform admin access required'), { statusCode: 403 })
		);

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 403 });
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});

	it('fails 503 when the instance secret is not configured', async () => {
		getInstanceSecretMock.mockImplementation(() => {
			throw Object.assign(new Error('In-app apply not configured'), { statusCode: 503 });
		});

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 503 });
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/system/apply-profiles — body validation', () => {
	it.each([
		['missing flags', {}],
		['null flags', { flags: null }],
		['array flags', { flags: ['mail.external'] }],
		['non-boolean value', { flags: { 'mail.external': 'yes' } }],
	])('rejects %s with 400', async (_name, invalidBody) => {
		body = invalidBody;

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 400 });
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/system/apply-profiles — updater proxying', () => {
	it('forwards the flag snapshot with the instance secret and returns the result', async () => {
		const payload = {
			success: true,
			profiles: ['ai', 'external-mail'],
			services: [{ service: 'mail-sync', state: 'running' }],
		};
		callUpdaterMock.mockResolvedValue(updaterResponse(true, payload));

		const result = await callRoute();

		expect(callUpdaterMock).toHaveBeenCalledTimes(1);
		const [path, secret, init] = callUpdaterMock.mock.calls[0] as [
			string,
			string,
			{ method: string; body: string },
		];
		expect(path).toBe('/apply-profiles');
		expect(secret).toBe(INSTANCE_SECRET);
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ flags: { 'mail.external': true, ai: false } });
		expect(result).toEqual(payload);
	});

	it('maps an updater-reported failure to 502 with the updater message', async () => {
		callUpdaterMock.mockResolvedValue(
			updaterResponse(false, { success: false, error: 'docker compose up failed' })
		);

		await expect(callRoute()).rejects.toMatchObject({
			statusCode: 502,
			message: 'docker compose up failed',
		});
	});

	it('maps an unreachable updater to 502', async () => {
		callUpdaterMock.mockRejectedValue(new Error('fetch failed'));

		await expect(callRoute()).rejects.toMatchObject({
			statusCode: 502,
			message: 'fetch failed',
		});
	});
});

/**
 * The gate itself, not its mock: an unauthenticated request must be refused by
 * the shipped `requirePlatformAdmin` before the route reaches the updater.
 */
describe('POST /api/system/apply-profiles — the real platform-admin gate', () => {
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
