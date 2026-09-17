/**
 * The raw `.eml` upload endpoint the mail-sync worker PUTs to.
 *
 * It exists because a Convex function-call body is capped at 16 MiB and base64
 * inflates by 4/3: shipping the message as an ARGUMENT silently dropped every
 * message over ~12 MiB of source at the backend's HTTP layer, which on a real
 * mailbox was about one message in twenty. The cases below pin the two things
 * that makes true — the route is gated on the shared worker secret, and a body
 * far larger than the old argument ceiling is accepted and stored.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../../../schema';

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

/** The argument ceiling this endpoint exists to get out from under. */
const OLD_ARGUMENT_CEILING_BYTES = 16 * 1024 * 1024;

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

	it('accepts a message far past the old function-argument ceiling', async () => {
		// The whole point: 20 MiB as a base64 argument was rejected by Convex
		// before any handler ran. As a body it is just a body.
		const t = convexTest(schema, modules);
		const raw = message(OLD_ARGUMENT_CEILING_BYTES + 4 * 1024 * 1024);

		const res = await post(t, raw, { Authorization: `Bearer ${KEY}` });

		expect(res.status).toBe(200);
		expect(((await res.json()) as { size: number }).size).toBe(raw.byteLength);
	});

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
