import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the `GET /.well-known/mta-sts.txt` route (RFC 8461 §3.2 policy
 * serving). Asserts the two contract points the reviewer gate names:
 *   1. HOST-MATCHING — the policy is served ONLY from `mta-sts.<domain>`; any
 *      other host 404s so the file can't be fetched from the wrong origin.
 *   2. CONTENT TYPE — a published policy is returned as `text/plain; charset=utf-8`.
 * Plus: a 404 when nothing is published (the Convex query returns null).
 *
 * The h3 auto-imports and the Convex client are stubbed so the route's own
 * control flow is exercised in isolation, with no network.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('convex/browser', () => ({
	ConvexHttpClient: vi.fn().mockImplementation(() => ({ query: queryMock })),
}));

// The generated Convex api is only used as an opaque function reference here.
vi.mock('@owlat/api', () => ({
	api: { domains: { domains: { getMtaStsPolicy: 'getMtaStsPolicy' } } },
}));

let requestHost = 'mta-sts.example.com';
const responseHeaders: Record<string, string> = {};

interface HttpError {
	statusCode: number;
	statusMessage: string;
}

beforeEach(() => {
	queryMock.mockReset();
	requestHost = 'mta-sts.example.com';
	for (const key of Object.keys(responseHeaders)) delete responseHeaders[key];

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('getRequestHost', () => requestHost);
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

async function callRoute(): Promise<string> {
	const mod = await import('../.well-known/mta-sts.txt.get');
	const handler = mod.default as unknown as (event: unknown) => Promise<string>;
	return handler({});
}

describe('isMtaStsHost', () => {
	it('accepts the mta-sts subdomain (case-insensitively) and rejects others', async () => {
		const { isMtaStsHost } = await import('../.well-known/mta-sts.txt.get');
		expect(isMtaStsHost('mta-sts.example.com')).toBe(true);
		expect(isMtaStsHost('MTA-STS.example.com')).toBe(true);
		expect(isMtaStsHost('example.com')).toBe(false);
		expect(isMtaStsHost('www.example.com')).toBe(false);
	});
});

describe('GET /.well-known/mta-sts.txt', () => {
	const BODY = 'version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmax_age: 604800\r\n';

	it('serves the policy body as text/plain on the mta-sts host', async () => {
		queryMock.mockResolvedValue({ mode: 'enforce', policyId: 'abcd1234abcd1234', body: BODY });
		const result = await callRoute();
		expect(result).toBe(BODY);
		expect(responseHeaders['Content-Type']).toBe('text/plain; charset=utf-8');
	});

	it('404s when requested on a non-mta-sts host', async () => {
		requestHost = 'www.example.com';
		await expect(callRoute()).rejects.toMatchObject({ statusCode: 404 });
		// Never reaches Convex on the wrong host.
		expect(queryMock).not.toHaveBeenCalled();
	});

	it('404s when no policy is published (query returns null)', async () => {
		queryMock.mockResolvedValue(null);
		await expect(callRoute()).rejects.toMatchObject({ statusCode: 404 });
	});
});
