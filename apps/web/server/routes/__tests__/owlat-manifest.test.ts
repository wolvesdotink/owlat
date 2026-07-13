import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /.well-known/owlat.json` — the signed instance manifest.
 *   - Serves the manifest object as `application/json` when the Convex action
 *     returns one.
 *   - 404s before the instance identity is minted (the action returns null).
 *
 * The Convex client's `.action()` (not `.query()`) is stubbed, since the
 * manifest is signed in a Node action.
 */

const { actionMock } = vi.hoisted(() => ({ actionMock: vi.fn() }));

vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		action = actionMock;
	},
}));

vi.mock('@owlat/api', () => ({
	api: { e2ee: { manifest: { getSignedManifest: 'getSignedManifest' } } },
}));

const responseHeaders: Record<string, string> = {};

interface HttpError {
	statusCode: number;
	statusMessage: string;
}

beforeEach(() => {
	actionMock.mockReset();
	for (const key of Object.keys(responseHeaders)) delete responseHeaders[key];

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexUrl: 'https://convex.example.com' },
	}));
	vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: string) => {
		responseHeaders[name] = value;
	});
	vi.stubGlobal('createError', (opts: HttpError) => {
		const err = new Error(opts.statusMessage) as Error & HttpError;
		err.statusCode = opts.statusCode;
		err.statusMessage = opts.statusMessage;
		return err;
	});
});

async function callRoute(): Promise<unknown> {
	const mod = await import('../.well-known/owlat.json.get');
	const handler = mod.default as unknown as (event: unknown) => Promise<unknown>;
	return handler({});
}

describe('GET /.well-known/owlat.json', () => {
	it('serves the signed manifest as application/json', async () => {
		const manifest = {
			version: 1,
			instance: { fingerprint: 'AABB', publicKeyArmored: 'PUB' },
			features: { e2ee: 1 },
			keyDirectoryDigest: 'deadbeef',
			rotationFeedUrl: 'https://sealed.example.com/.well-known/owlat.json',
			generatedAt: 1_800_000_000_000,
			signature: '-----BEGIN PGP SIGNATURE-----',
		};
		actionMock.mockResolvedValue(manifest);

		const result = await callRoute();
		expect(result).toEqual(manifest);
		expect(responseHeaders['Content-Type']).toBe('application/json; charset=utf-8');
		expect(responseHeaders['Cache-Control']).toBe('no-store');
		expect(actionMock).toHaveBeenCalledWith('getSignedManifest', {});
	});

	it('404s before the instance identity is minted (action returns null)', async () => {
		actionMock.mockResolvedValue(null);
		await expect(callRoute()).rejects.toMatchObject({ statusCode: 404 });
	});
});
