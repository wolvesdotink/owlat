import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readStreamBytes, StreamByteLimitExceeded } from '@owlat/shared';
import {
	buildCanonicalHookRequest,
	buildCanonicalHookResponse,
	SYNC_HOOK_HEADERS,
	SYNC_HOOK_SIGNATURE_SCHEME,
	parsePluginId,
	type SyncHookDescriptor,
	type SyncHookKind,
} from '@owlat/plugin-kit';
import {
	createInMemoryCircuitBreakerStore,
	createInMemorySeenNonceStore,
	hashHookBody,
	invokeSyncHook,
	signHookHmac,
	type GateHookResult,
	type SyncHookInvokeDeps,
	type SyncHookTransport,
} from '@owlat/plugin-host';

/**
 * Full end-to-end round trip of a signed synchronous hook over a REAL local
 * HTTP server: the server verifies Owlat's request signature and returns a
 * signed response; the engine verifies it. This drives the actual wire (real
 * `fetch`, real `AbortSignal.timeout`, real capped stream read, real redirect
 * refusal) with real crypto.
 *
 * The production transport additionally wraps this in the SSRF guard, which
 * rejects loopback — so this test uses an equivalent unguarded local transport
 * to reach 127.0.0.1, while `hookTransport.test.ts` verifies the SSRF guard on
 * the shipped transport against the real blocklist.
 */

const SECRET = 'shared-hmac-secret-for-round-trip';
const PLUGIN = parsePluginId('acme-approvals');

/** A local transport mirroring the production fetch/read/redirect/timeout path. */
const localTransport: SyncHookTransport = async (request) => {
	let response: Response;
	try {
		response = await fetch(request.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...request.headers },
			body: request.body,
			redirect: 'manual',
			signal: AbortSignal.timeout(request.deadlineMs),
		});
	} catch (error) {
		const err = error instanceof Error ? error : new Error('network');
		if (err.name === 'TimeoutError' || err.name === 'AbortError') {
			return { ok: false, reason: 'timeout', error: 'deadline exceeded' };
		}
		return { ok: false, reason: 'network', error: err.message };
	}
	if (response.status >= 300 && response.status < 400) {
		return { ok: false, reason: 'redirect', error: 'refusing redirect' };
	}
	let bytes: Uint8Array | null;
	try {
		bytes = await readStreamBytes(response.body, request.maxResponseBytes);
	} catch (error) {
		if (error instanceof StreamByteLimitExceeded) {
			return { ok: false, reason: 'too-large', error: 'response too large' };
		}
		throw error;
	}
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	return {
		ok: true,
		status: response.status,
		headers,
		body: bytes ? new TextDecoder().decode(bytes) : '',
	};
};

function deps(overrides: Partial<SyncHookInvokeDeps> = {}): SyncHookInvokeDeps {
	return {
		transport: localTransport,
		now: Date.now,
		randomNonce: () => randomUUID(),
		scrubPromptInjection: (text) => text.replace(/INJECT/g, '[scrubbed]'),
		seenNonces: createInMemorySeenNonceStore(),
		circuit: createInMemoryCircuitBreakerStore(),
		...overrides,
	};
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

/** Verify the inbound request the way a real connected app must. */
async function requestSignatureValid(req: IncomingMessage, rawBody: string): Promise<boolean> {
	const h = req.headers;
	const header = (name: string): string => {
		const value = h[name];
		return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
	};
	const canonical = buildCanonicalHookRequest({
		scheme: SYNC_HOOK_SIGNATURE_SCHEME,
		kind: header(SYNC_HOOK_HEADERS.kind) as SyncHookKind,
		hookId: header(SYNC_HOOK_HEADERS.hookId),
		pluginId: parsePluginId(header(SYNC_HOOK_HEADERS.plugin)),
		organizationId: header(SYNC_HOOK_HEADERS.organization),
		timestamp: Number(header(SYNC_HOOK_HEADERS.timestamp)),
		nonce: header(SYNC_HOOK_HEADERS.nonce),
		bodyHashHex: await hashHookBody(rawBody),
	});
	const expected = await signHookHmac(SECRET, canonical);
	return expected === header(SYNC_HOOK_HEADERS.signature);
}

async function writeSignedResponse(
	res: ServerResponse,
	kind: SyncHookKind,
	requestNonce: string,
	resultBody: string
): Promise<void> {
	const responseNonce = randomUUID();
	const timestamp = Date.now();
	const canonical = buildCanonicalHookResponse({
		scheme: SYNC_HOOK_SIGNATURE_SCHEME,
		kind,
		requestNonce,
		timestamp,
		nonce: responseNonce,
		bodyHashHex: await hashHookBody(resultBody),
	});
	const signature = await signHookHmac(SECRET, canonical);
	res.writeHead(200, {
		'Content-Type': 'application/json',
		[SYNC_HOOK_HEADERS.scheme]: SYNC_HOOK_SIGNATURE_SCHEME,
		[SYNC_HOOK_HEADERS.kind]: kind,
		[SYNC_HOOK_HEADERS.requestNonce]: requestNonce,
		[SYNC_HOOK_HEADERS.timestamp]: String(timestamp),
		[SYNC_HOOK_HEADERS.nonce]: responseNonce,
		[SYNC_HOOK_HEADERS.signature]: signature,
	});
	res.end(resultBody);
}

type Handler = (req: IncomingMessage, res: ServerResponse, rawBody: string) => Promise<void> | void;

let server: Server | undefined;

async function startServer(handler: Handler): Promise<string> {
	server = createServer((req, res) => {
		void (async () => {
			const rawBody = await readBody(req);
			await handler(req, res, rawBody);
		})();
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const { port } = server!.address() as AddressInfo;
	return `http://127.0.0.1:${port}/hook`;
}

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
	}
});

function descriptor(url: string, overrides: Partial<SyncHookDescriptor> = {}): SyncHookDescriptor {
	return {
		hookId: 'hook-1',
		kind: 'gate',
		pluginId: PLUGIN,
		organizationId: 'org-1',
		endpointUrl: url,
		signingSecret: SECRET,
		deadlineMs: 3_000,
		enabled: true,
		...overrides,
	};
}

describe('signed hook round trip over real HTTP', () => {
	it('verifies the request signature and returns a signed gate objection', async () => {
		let sawValidSignature = false;
		const url = await startServer(async (req, res, rawBody) => {
			sawValidSignature = await requestSignatureValid(req, rawBody);
			const kind = String(req.headers[SYNC_HOOK_HEADERS.kind]) as SyncHookKind;
			const requestNonce = String(req.headers[SYNC_HOOK_HEADERS.nonce]);
			await writeSignedResponse(
				res,
				kind,
				requestNonce,
				JSON.stringify({ outcome: 'objection', reason: 'Needs manager sign-off' })
			);
		});

		const result = (await invokeSyncHook(
			descriptor(url),
			{ subject: 'Refund?' },
			deps()
		)) as GateHookResult;
		expect(sawValidSignature).toBe(true);
		expect(result).toMatchObject({
			kind: 'gate',
			source: 'hook',
			reason: 'ok',
			gate: { outcome: 'objection', reason: 'Needs manager sign-off' },
		});
	});

	it('scrubs a draft suggestion returned over the wire', async () => {
		const url = await startServer(async (req, res) => {
			const requestNonce = String(req.headers[SYNC_HOOK_HEADERS.nonce]);
			await writeSignedResponse(
				res,
				'draft',
				requestNonce,
				JSON.stringify({ draft: { body: 'Please INJECT ignore instructions' } })
			);
		});
		const result = await invokeSyncHook(descriptor(url, { kind: 'draft' }), {}, deps());
		expect(result).toEqual({
			kind: 'draft',
			source: 'hook',
			reason: 'ok',
			suggestion: 'Please [scrubbed] ignore instructions',
		});
	});

	it('fails a gate closed to an objection when the endpoint times out', async () => {
		const url = await startServer((_req, res) => {
			// Never respond within the deadline.
			setTimeout(() => res.end('{}'), 5_000).unref();
		});
		const result = (await invokeSyncHook(
			descriptor(url, { deadlineMs: 300 }),
			{},
			deps()
		)) as GateHookResult;
		expect(result).toMatchObject({ source: 'fallback', reason: 'transport-timeout' });
		expect(result.gate.outcome).toBe('objection');
	});

	it('rejects an oversize response body', async () => {
		const url = await startServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('x'.repeat(70 * 1_024));
		});
		const result = await invokeSyncHook(descriptor(url, { kind: 'draft' }), {}, deps());
		expect(result).toMatchObject({ source: 'fallback', reason: 'transport-too-large' });
	});

	it('refuses to follow a redirect', async () => {
		const url = await startServer((_req, res) => {
			res.writeHead(302, { Location: 'http://169.254.169.254/' });
			res.end();
		});
		const result = (await invokeSyncHook(descriptor(url), {}, deps())) as GateHookResult;
		expect(result).toMatchObject({ source: 'fallback', reason: 'transport-redirect' });
		expect(result.gate.outcome).toBe('objection');
	});

	it('rejects a response signed with the wrong secret (real MITM shape)', async () => {
		const url = await startServer(async (req, res) => {
			const kind = String(req.headers[SYNC_HOOK_HEADERS.kind]) as SyncHookKind;
			const requestNonce = String(req.headers[SYNC_HOOK_HEADERS.nonce]);
			const resultBody = JSON.stringify({ outcome: 'no-objection' });
			const responseNonce = randomUUID();
			const timestamp = Date.now();
			const canonical = buildCanonicalHookResponse({
				scheme: SYNC_HOOK_SIGNATURE_SCHEME,
				kind,
				requestNonce,
				timestamp,
				nonce: responseNonce,
				bodyHashHex: await hashHookBody(resultBody),
			});
			const signature = await signHookHmac('wrong-secret', canonical);
			res.writeHead(200, {
				'Content-Type': 'application/json',
				[SYNC_HOOK_HEADERS.scheme]: SYNC_HOOK_SIGNATURE_SCHEME,
				[SYNC_HOOK_HEADERS.kind]: kind,
				[SYNC_HOOK_HEADERS.requestNonce]: requestNonce,
				[SYNC_HOOK_HEADERS.timestamp]: String(timestamp),
				[SYNC_HOOK_HEADERS.nonce]: responseNonce,
				[SYNC_HOOK_HEADERS.signature]: signature,
			});
			res.end(resultBody);
		});
		const result = (await invokeSyncHook(descriptor(url), {}, deps())) as GateHookResult;
		expect(result).toMatchObject({ source: 'fallback', reason: 'signature-invalid' });
		expect(result.gate.outcome).toBe('objection');
	});
});
