/**
 * Sealed Mail E8b — the decrypt-serving blob PROXY (`GET /sealed-blob`).
 *
 * Proves the transparent decrypt-serving contract the out-of-process consumers
 * (web reader, IMAP bridge, outbound MTA) depend on:
 *   - a URL minted by `sealedBlobUrl` fetches the blob's PLAINTEXT bytes back,
 *     even though the stored blob is ciphertext (a storage dump would not hold
 *     the canary);
 *   - a forged / tampered / expired capability token is a flat 403, no blob read;
 *   - a legacy (unsealed) blob still serves verbatim (mixed-state tolerance).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import schema from '../../schema';
import { storeSealedBlob, sealedBlobUrl, SEALED_BLOB_PATH } from '../../lib/sealedBlob';
import { isSealedBytesAtRest } from '../../lib/atRestBodies';
import type { Id } from '../../_generated/dataModel';

const rootGlob = import.meta.glob('../../**/*.*s');
const mailGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../mail/'),
		mod,
	])
);
const modules = { ...rootGlob, ...mailGlob };

const SECRET = 'test-instance-secret-value-for-aes-256-gcm-kdf';
const SITE = 'https://example.convex.site';
const CANARY = 'CANARY-body-plaintext-9f3a-do-not-leak';
const enc = new TextEncoder();

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	vi.stubEnv('CONVEX_SITE_URL', SITE);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/** Store a canary-bearing blob (sealed) and return its id + the minted URL. */
async function seedSealedBlob(
	t: ReturnType<typeof convexTest>,
	contentType: string
): Promise<{ storageId: Id<'_storage'>; url: string }> {
	const storageId = await t.run((ctx) =>
		storeSealedBlob(ctx.storage, enc.encode(`${CANARY} blob body`), contentType)
	);
	const url = await t.run((ctx) => sealedBlobUrl(ctx.storage, storageId, contentType));
	expect(url).toBeTruthy();
	return { storageId, url: url as string };
}

describe('sealed-blob decrypt-serving proxy', () => {
	it('stores ciphertext but serves plaintext through the proxy URL', async () => {
		const t = convexTest(schema, modules);
		const { storageId, url } = await seedSealedBlob(t, 'message/rfc822');

		// The stored blob is genuinely ciphertext (a storage dump holds no canary).
		// `t.run` cannot return a Uint8Array (not a Convex value) — return the raw
		// ArrayBuffer and wrap it outside the callback.
		const storedBytes = new Uint8Array(
			await t.run(async (ctx) => {
				const blob = await ctx.storage.get(storageId);
				return await blob!.arrayBuffer();
			})
		);
		expect(isSealedBytesAtRest(storedBytes)).toBe(true);
		expect(new TextDecoder().decode(storedBytes)).not.toContain(CANARY);

		// The proxy URL is rooted at the site URL + route path.
		expect(url.startsWith(`${SITE}${SEALED_BLOB_PATH}?`)).toBe(true);

		// Fetching it yields the ORIGINAL plaintext bytes.
		const res = await t.fetch(url.slice(SITE.length), { method: 'GET' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('message/rfc822');
		expect(await res.text()).toContain(CANARY);
	});

	it('rejects a forged signature with 403', async () => {
		const t = convexTest(schema, modules);
		const { url } = await seedSealedBlob(t, 'message/rfc822');
		const tampered = url.replace(/sig=[^&]+/, 'sig=forged-signature-value');
		const res = await t.fetch(tampered.slice(SITE.length), { method: 'GET' });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: { category: 'forbidden', message: 'Forbidden' },
		});
	});

	it('rejects an expired token with 403', async () => {
		const t = convexTest(schema, modules);
		const { storageId } = await seedSealedBlob(t, 'message/rfc822');
		// Re-mint with a past expiry by freezing time in the past for the mint.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.now() - 2 * 60 * 60 * 1000));
		const staleUrl = await t.run((ctx) => sealedBlobUrl(ctx.storage, storageId, 'message/rfc822'));
		vi.useRealTimers();
		const res = await t.fetch((staleUrl as string).slice(SITE.length), { method: 'GET' });
		expect(res.status).toBe(403);
	});

	it('serves a legacy (unsealed) blob verbatim (mixed-state tolerance)', async () => {
		const t = convexTest(schema, modules);
		// A pre-E8b blob written straight to storage without the byte cipher.
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob([`${CANARY} legacy`], { type: 'text/plain' }))
		);
		const url = await t.run((ctx) => sealedBlobUrl(ctx.storage, storageId, 'text/plain'));
		const res = await t.fetch((url as string).slice(SITE.length), { method: 'GET' });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain(CANARY);
	});
});
