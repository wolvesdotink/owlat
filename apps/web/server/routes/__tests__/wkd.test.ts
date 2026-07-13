import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the WKD (Web Key Directory) Nuxt routes:
 *   - `GET /.well-known/openpgpkey/policy` — 200 only while Sealed Mail is on;
 *     disabling the feature withdraws the WKD capability with a 404.
 *   - `GET /.well-known/openpgpkey/hu/<hash>` — returns the BINARY public key as
 *     `application/octet-stream` for a known (host, hash); 404s for an unknown
 *     local-part (Convex query returns null) and when the hash segment is empty.
 *
 * The h3 auto-imports and the Convex client are stubbed so the route control
 * flow is exercised in isolation, with no network.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		query = queryMock;
	},
}));

vi.mock('@owlat/api', () => ({
	api: {
		e2ee: { keys: { getKeyForWkd: 'getKeyForWkd' } },
		workspaces: { featureFlags: { getFeatureFlags: 'getFeatureFlags' } },
	},
}));

let requestHost = 'sealed.example.com';
let hashParam: string | undefined = 'kei1q4tipxxu1yj79k9kfukdhfy631xe';
const responseHeaders: Record<string, string> = {};

interface HttpError {
	statusCode: number;
	statusMessage: string;
}

beforeEach(() => {
	queryMock.mockReset();
	requestHost = 'sealed.example.com';
	hashParam = 'kei1q4tipxxu1yj79k9kfukdhfy631xe';
	for (const key of Object.keys(responseHeaders)) delete responseHeaders[key];

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('getRequestHost', () => requestHost);
	vi.stubGlobal('getRouterParam', () => hashParam);
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

async function callPolicy(): Promise<string> {
	const mod = await import('../.well-known/openpgpkey/policy.get');
	const handler = mod.default as unknown as (event: unknown) => Promise<string>;
	return await handler({});
}

async function callHu(): Promise<Uint8Array> {
	const mod = await import('../.well-known/openpgpkey/hu/[hash].get');
	const handler = mod.default as unknown as (event: unknown) => Promise<Uint8Array>;
	return handler({});
}

describe('GET /.well-known/openpgpkey/policy', () => {
	it('serves an empty text/plain policy file', async () => {
		queryMock.mockResolvedValue({ sealedMail: true });
		const body = await callPolicy();
		expect(body).toBe('');
		expect(responseHeaders['Content-Type']).toBe('text/plain; charset=utf-8');
		expect(responseHeaders['Cache-Control']).toBe('no-store');
	});

	it('404s when Sealed Mail is disabled', async () => {
		queryMock.mockResolvedValue({ sealedMail: false });
		await expect(callPolicy()).rejects.toMatchObject({ statusCode: 404 });
	});
});

describe('GET /.well-known/openpgpkey/hu/<hash>', () => {
	it('serves the binary public key as application/octet-stream', async () => {
		const keyBytes = Buffer.from([0x99, 0x01, 0x02, 0x03]);
		queryMock.mockResolvedValue({ binaryBase64: keyBytes.toString('base64') });

		const result = await callHu();
		expect(Buffer.from(result)).toEqual(keyBytes);
		expect(responseHeaders['Content-Type']).toBe('application/octet-stream');
		expect(responseHeaders['Cache-Control']).toBe('no-store');
		expect(queryMock).toHaveBeenCalledWith('getKeyForWkd', {
			domain: 'sealed.example.com',
			wkdHash: 'kei1q4tipxxu1yj79k9kfukdhfy631xe',
		});
	});

	it('lowercases the request host before matching', async () => {
		requestHost = 'Sealed.Example.COM';
		queryMock.mockResolvedValue({ binaryBase64: Buffer.from([1]).toString('base64') });
		await callHu();
		expect(queryMock).toHaveBeenCalledWith('getKeyForWkd', {
			domain: 'sealed.example.com',
			wkdHash: 'kei1q4tipxxu1yj79k9kfukdhfy631xe',
		});
	});

	it('404s for an unknown local-part (query returns null)', async () => {
		queryMock.mockResolvedValue(null);
		await expect(callHu()).rejects.toMatchObject({ statusCode: 404 });
	});

	it('404s when the hash segment is empty (never reaches Convex)', async () => {
		hashParam = '';
		await expect(callHu()).rejects.toMatchObject({ statusCode: 404 });
		expect(queryMock).not.toHaveBeenCalled();
	});
});
