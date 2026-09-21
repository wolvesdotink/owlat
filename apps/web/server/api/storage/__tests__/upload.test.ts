// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createApp, createError, toNodeListener } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ARCHIVE_IMPORT_BYTES } from '@owlat/shared/mboxArchive';
import handler from '../upload.post';

const servers: Server[] = [];
async function listen(server: Server) {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'test-server-secret');
	vi.stubGlobal('createError', createError);
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				})
		)
	);
});
async function fixture(
	options: { rejectToken?: boolean; failFinish?: boolean; redirect?: boolean } = {}
) {
	let bytes = 0;
	const controls: { operation: string; body: Record<string, unknown>; auth?: string }[] = [];
	const nativeHeaders: Record<string, unknown>[] = [];
	const callback = vi.fn();
	const callbackUrl = await listen(
		createServer((_req, res) => {
			callback();
			res.end();
		})
	);
	const nativeUrl = await listen(
		createServer(async (req, res) => {
			nativeHeaders.push(req.headers);
			try {
				for await (const chunk of req) bytes += chunk.length;
			} catch {
				return;
			}
			if (options.redirect) {
				res.writeHead(307, { Location: callbackUrl });
				res.end();
				return;
			}
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ storageId: 'server-returned-storage-id' }));
		})
	);
	const controlUrl = await listen(
		createServer(async (req, res) => {
			let body = '';
			for await (const chunk of req) body += chunk;
			const operation = req.url!.split('/').pop()!;
			controls.push({ operation, body: JSON.parse(body), auth: req.headers.authorization });
			if (
				(operation === 'begin' && options.rejectToken) ||
				(operation === 'finish' && options.failFinish)
			) {
				res.writeHead(401);
				res.end('{}');
				return;
			}
			res.setHeader('Content-Type', 'application/json');
			res.end(
				JSON.stringify(
					operation === 'begin' ? { uploadId: 'receipt-id', uploadUrl: nativeUrl } : { ok: true }
				)
			);
		})
	);
	vi.stubGlobal('useRuntimeConfig', () => ({ convexSiteUrlInternal: controlUrl, public: {} }));
	const proxy = await listen(createServer(toNodeListener(createApp().use(handler))));
	return {
		proxy,
		nativeUrl,
		controls,
		nativeHeaders,
		callback,
		get bytes() {
			return bytes;
		},
	};
}
function stream(size: number) {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === size) {
				controller.close();
				return;
			}
			const length = Math.min(size - sent, 64 * 1024);
			sent += length;
			controller.enqueue(new Uint8Array(length));
		},
	});
}
function post(url: string, size: number) {
	return fetch(url, {
		method: 'POST',
		body: stream(size),
		duplex: 'half',
		headers: {
			'Content-Type': 'application/octet-stream',
			Cookie: 'private-cookie',
			Authorization: 'private-browser-auth',
		},
	} as RequestInit & { duplex: 'half' });
}
describe('streaming upload receipt bridge', () => {
	it('pauses incoming bytes while the native storage consumer is stalled', async () => {
		const f = await fixture();
		const nativeFetch = globalThis.fetch;
		const toWeb = Readable.toWeb;
		let consumed = 0;
		vi.spyOn(Readable, 'toWeb').mockImplementation((readable, options) => {
			readable.on('data', (chunk: Buffer) => {
				consumed += chunk.byteLength;
			});
			return toWeb(readable, options);
		});
		let release!: () => void;
		let started!: () => void;
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const nativeStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) !== f.nativeUrl) return nativeFetch(url, init);
			const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
			started();
			await stalled;
			while (!(await reader.read()).done) {
				/* Drain after releasing backpressure. */
			}
			return new Response(JSON.stringify({ storageId: 'server-returned-storage-id' }), {
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const totalBytes = 4 * 1024 * 1024;
		const uploading = post(`${f.proxy}?token=one-use`, totalBytes);
		await nativeStarted;
		await new Promise((resolve) => setTimeout(resolve, 100));
		const consumedWhileStalled = consumed;
		release();
		const response = await uploading;
		expect(response.status).toBe(200);
		expect(consumedWhileStalled).toBeGreaterThan(0);
		// Allow a pending transform chunk and Node's own read-ahead in addition
		// to the 64 KiB WebStream queue, independently of total upload size.
		expect(consumedWhileStalled).toBeLessThanOrEqual(256 * 1024);
		expect(consumed).toBe(totalBytes);
	});
	it('streams files larger than the Convex HTTP limit and attests only the native response id', async () => {
		const f = await fixture();
		const response = await post(`${f.proxy}?token=one-use&storageId=forged`, 21 * 1024 * 1024);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ storageId: 'server-returned-storage-id' });
		expect(f.bytes).toBe(21 * 1024 * 1024);
		expect(f.controls).toEqual([
			{ operation: 'begin', body: { token: 'one-use' }, auth: 'Bearer test-server-secret' },
			{
				operation: 'finish',
				body: { uploadId: 'receipt-id', storageId: 'server-returned-storage-id' },
				auth: 'Bearer test-server-secret',
			},
		]);
		expect(f.nativeHeaders[0]?.authorization).toBeUndefined();
		expect(f.nativeHeaders[0]?.cookie).toBeUndefined();
	});
	it('enforces the cap on chunked bytes and aborts without issuing a receipt', async () => {
		const f = await fixture();
		const response = await post(`${f.proxy}?token=one-use`, MAX_ARCHIVE_IMPORT_BYTES + 1);
		expect(response.status).toBe(413);
		expect(f.bytes).toBeLessThanOrEqual(MAX_ARCHIVE_IMPORT_BYTES);
		expect(f.controls.map((c) => c.operation)).toEqual(['begin', 'abort']);
	});
	it('rejects an invalid capability before forwarding bytes', async () => {
		const f = await fixture({ rejectToken: true });
		expect((await post(`${f.proxy}?token=expired`, 10)).status).toBe(401);
		expect(f.nativeHeaders).toEqual([]);
	});
	it('cleans up only the native response id if recording the receipt fails', async () => {
		const f = await fixture({ failFinish: true });
		expect((await post(`${f.proxy}?token=one-use`, 10)).status).toBe(502);
		expect(f.controls.at(-1)?.body).toEqual({
			uploadId: 'receipt-id',
			storageId: 'server-returned-storage-id',
		});
		expect(f.controls.at(-1)?.operation).toBe('abort');
	});
	it('rejects redirects from the native storage service', async () => {
		const f = await fixture({ redirect: true });
		expect((await post(`${f.proxy}?token=one-use`, 10)).status).toBe(502);
		expect(f.callback).not.toHaveBeenCalled();
	});
	it('fails closed without a token or configured service credential', async () => {
		const f = await fixture();
		expect((await post(f.proxy, 1)).status).toBe(401);
		vi.stubEnv('INSTANCE_SECRET', '');
		expect((await post(`${f.proxy}?token=one-use`, 1)).status).toBe(503);
		expect(f.controls).toEqual([]);
	});
});
