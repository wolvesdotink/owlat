/** Raw uploads authenticate before reading and enforce the buffered sealing budget. */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../../../schema';
import { MAX_RAW_MESSAGE_BYTES } from '../rawUploadHttp';
import { openBytesAtRest } from '../../../lib/atRestBodies';

const allModules = import.meta.glob('../../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agent') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

const PATH = '/mail-sync/raw-message';
const KEY = 'msk_test_secret';

function message(bytes: number): Uint8Array {
	const header = 'From: a@acme.test\r\nSubject: big\r\n\r\n';
	const body = new Uint8Array(bytes);
	body.fill(0x61);
	const encoded = new TextEncoder().encode(header);
	const out = new Uint8Array(encoded.length + body.length);
	out.set(encoded);
	out.set(body, encoded.length);
	return out;
}

function post(
	t: ReturnType<typeof convexTest>,
	body: Uint8Array,
	headers: Record<string, string>
): Promise<Response> {
	// `Uint8Array<ArrayBufferLike>` is not in this tsconfig's `BodyInit`; the
	// runtime accepts it, as it does everywhere else in this tree.
	return t.fetch(PATH, { method: 'POST', body: body as unknown as BodyInit, headers });
}

beforeEach(() => {
	process.env['MAIL_SYNC_API_KEY'] = KEY;
});
afterEach(() => {
	delete process.env['MAIL_SYNC_API_KEY'];
});

describe('POST /mail-sync/raw-message', () => {
	it('stores the bytes and answers with a usable storage id', async () => {
		const t = convexTest(schema, modules);
		const raw = message(1024);

		const res = await post(t, raw, { Authorization: `Bearer ${KEY}` });

		expect(res.status).toBe(200);
		const body = (await res.json()) as { storageId: string; size: number };
		expect(body.size).toBe(raw.byteLength);
		const stored = await t.run(async (ctx) => {
			const blob = await ctx.storage.get(body.storageId as never);
			return blob ? new Uint8Array(await blob.arrayBuffer()).byteLength : null;
		});
		expect(stored).not.toBeNull();
	});

	it('seals a message at the inclusive ceiling and preserves every byte', async () => {
		process.env['INSTANCE_SECRET'] = 'test-raw-message-secret';
		try {
			const t = convexTest(schema, modules);
			const raw = new Uint8Array(MAX_RAW_MESSAGE_BYTES).fill(97);
			const res = await post(t, raw, { Authorization: `Bearer ${KEY}` });
			expect(res.status).toBe(200);
			const { storageId, size } = await res.json();
			expect(size).toBe(raw.byteLength);
			const stored = await t.run(async (ctx) => (await ctx.storage.get(storageId))!.arrayBuffer());
			const opened = await openBytesAtRest('test-raw-message-secret', new Uint8Array(stored));
			expect(opened.byteLength).toBe(raw.byteLength);
			expect(opened.every((byte) => byte === 97)).toBe(true);
		} finally {
			delete process.env['INSTANCE_SECRET'];
		}
	});

	it.each([undefined, '1', String(MAX_RAW_MESSAGE_BYTES + 1)])(
		'rejects an oversized message with content-length %s',
		async (length) => {
			const t = convexTest(schema, modules);
			const res = await post(t, new Uint8Array(MAX_RAW_MESSAGE_BYTES + 1), {
				Authorization: `Bearer ${KEY}`,
				...(length === undefined ? {} : { 'Content-Length': length }),
			});
			expect(res.status).toBe(402);
			expect(await res.text()).toContain('8 MiB');
		}
	);

	it('refuses a caller with no key, the wrong key, or the wrong scheme', async () => {
		const t = convexTest(schema, modules);
		const raw = message(16);

		const cases: Record<string, string>[] = [
			{},
			{ Authorization: 'Bearer wrong' },
			{ Authorization: KEY }, // no `Bearer ` prefix
		];
		for (const headers of cases) {
			const res = await post(t, raw, headers);
			expect(res.status, JSON.stringify(headers)).toBe(401);
		}
	});

	it('fails closed when the instance has no worker secret configured', async () => {
		delete process.env['MAIL_SYNC_API_KEY'];
		const t = convexTest(schema, modules);

		const res = await post(t, message(16), { Authorization: `Bearer ${KEY}` });

		// Not 401: there is nothing to authenticate against, which is a different
		// thing to say than "your key is wrong".
		expect(res.status).not.toBe(200);
		expect(res.status).not.toBe(401);
	});

	it('refuses an empty body rather than storing a zero-byte message', async () => {
		const t = convexTest(schema, modules);

		const res = await post(t, new Uint8Array(0), { Authorization: `Bearer ${KEY}` });

		expect(res.status).toBe(400);
	});
});
