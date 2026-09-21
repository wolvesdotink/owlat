import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { storeSealedBlob, sealedBlobUrl, SEALED_BLOB_PATH } from '../lib/sealedBlob';

/**
 * Response-header hardening for the sealed-blob decrypt-serving proxy (M1).
 *
 * A sealed blob's content-type is attacker-influenceable (chosen by whoever
 * composed the sealed message), so the proxy must:
 *   - always send `X-Content-Type-Options: nosniff`;
 *   - render INLINE only the narrow allowlist (image/* except svg, application/pdf)
 *     and force `Content-Disposition: attachment` for everything else;
 *   - scope `Access-Control-Allow-Origin` to the configured app origin, never `*`.
 *
 * Driven through `t.fetch` against the real `/sealed-blob` route so the token
 * mint → verify → serve round trip is exercised end to end.
 */

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

const APP_ORIGIN = 'https://app.example.com';
const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['INSTANCE_SECRET'] = 'sealed-blob-header-test-secret-at-least-32-chars';
	process.env['CONVEX_SITE_URL'] = 'https://deploy.convex.site';
	process.env['ALLOWED_ORIGINS'] = APP_ORIGIN;
	delete process.env['OWLAT_DEV_MODE'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

async function serve(
	t: ReturnType<typeof convexTest>,
	bytes: Uint8Array,
	contentType: string,
	origin?: string
): Promise<Response> {
	const url = await t.run(async (ctx) => {
		const id = await storeSealedBlob(ctx.storage, bytes, contentType);
		return sealedBlobUrl(ctx.storage, id, contentType);
	});
	expect(url).not.toBeNull();
	const parsed = new URL(url!);
	return t.fetch(SEALED_BLOB_PATH + parsed.search, {
		method: 'GET',
		headers: origin ? { Origin: origin } : {},
	});
}

describe('serveSealedBlob response headers (M1)', () => {
	const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

	it('serves a non-inline type (text/html) as a nosniff attachment, never inline', async () => {
		const t = convexTest(schema, modules);
		const res = await serve(t, BYTES, 'text/html', APP_ORIGIN);

		expect(res.status).toBe(200);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Disposition')).toBe('attachment');
		expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
	});

	it('renders an allowlisted type (image/png) inline, still with nosniff', async () => {
		const t = convexTest(schema, modules);
		const res = await serve(t, BYTES, 'image/png', APP_ORIGIN);

		expect(res.status).toBe(200);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Disposition')).toBe('inline');
	});

	it('treats scriptable image/svg+xml as an attachment, not inline', async () => {
		const t = convexTest(schema, modules);
		const res = await serve(t, BYTES, 'image/svg+xml', APP_ORIGIN);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Disposition')).toBe('attachment');
	});

	it('scopes Access-Control-Allow-Origin to the app origin, never "*"', async () => {
		const t = convexTest(schema, modules);
		const res = await serve(t, BYTES, 'application/pdf', APP_ORIGIN);

		const acao = res.headers.get('Access-Control-Allow-Origin');
		expect(acao).not.toBe('*');
		expect(acao).toBe(APP_ORIGIN);
	});

	it('never reflects a foreign origin into Access-Control-Allow-Origin', async () => {
		const t = convexTest(schema, modules);
		const res = await serve(t, BYTES, 'application/pdf', 'https://evil.example.net');

		const acao = res.headers.get('Access-Control-Allow-Origin');
		expect(acao).not.toBe('*');
		expect(acao).not.toBe('https://evil.example.net');
		expect(acao).toBe(APP_ORIGIN);
	});

	it('still rejects a forged/absent capability token with 403 regardless of headers', async () => {
		const t = convexTest(schema, modules);
		const res = await t.fetch(
			`${SEALED_BLOB_PATH}?id=bogus&ct=text/plain&exp=9999999999999&sig=nope`,
			{
				method: 'GET',
			}
		);
		expect(res.status).toBe(403);
	});
});
