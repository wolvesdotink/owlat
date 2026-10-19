/**
 * THE RESEND ADAPTER'S WIRE ENCODING, THROUGH THE REAL SDK.
 *
 * Every other Resend suite replaces the SDK's `emails.send` (see
 * `ambiguousTimeout.test.ts`), so it sees only the adapter's INPUT to the SDK.
 * Two facts live below that seam, inside the SDK's serializer:
 *
 * - the adapter passes `contentType` and the SDK's `parseAttachments` renames
 *   it to the `content_type` wire field. Passing the wire spelling instead was
 *   a real bug: it was dropped as an excess property and Resend guessed the
 *   type from the filename;
 * - the `idempotencyKey` request option becomes the `Idempotency-Key` header,
 *   which is what makes a retry after an ambiguous timeout safe.
 *
 * Here the real `resend` package runs and only `fetch` is replaced, so an SDK
 * upgrade that renames either field fails this suite. No request leaves the
 * process: the stub records the request and answers it, and the API key is
 * synthetic.
 *
 * Stubbing `fetch` alone would not keep an SDK that moved to `node:https`, its
 * own fetch or its own DNS client off the network. So while this file runs,
 * `refuseEgress` refuses and records every Node egress entry point a JS
 * dependency can reach (TCP/TLS socket connects, every `node:dns` lookup and
 * resolve, UDP sends), and any attempt fails the test.
 *
 * Limits: the guard covers this JS realm only. A native addon, a child process
 * or a worker thread opens its own sockets and is out of reach of an
 * in-process guard. This suite proves the JS transport boundary, nothing more.
 */

import dgram from 'node:dgram';
import dns, { lookup as esmLookup } from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendSendProvider, _resetResendClientCacheForTests } from '../resend';
import { resolveSendTransport, _resetSendTransportCacheForTests } from '../transports';
import type { EmailSendParams } from '../types';

interface CapturedRequest {
	url: string;
	method: string | undefined;
	headers: Headers;
	body: Record<string, unknown>;
}

const params: EmailSendParams = {
	to: 'to@example.com',
	from: 'from@owlat.example',
	subject: 'Quarterly report',
	html: '<p>Attached.</p>',
	text: 'Attached.',
};

/** Bytes that are not valid UTF-8, so a lossy text round trip would show. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x80]);

let requests: CapturedRequest[];

const EGRESS_BLOCKED = 'resendWireEncoding.test: egress blocked';
/** Every refused attempt, as `<entry point>(<host>)`. */
const egressAttempts: string[] = [];

/** `node:dns` names that send a query: `lookup*`, `resolve*` and `reverse*`. */
function dnsQueryNames(target: object): string[] {
	return Object.getOwnPropertyNames(target).filter(
		(name) =>
			/^(lookup|resolve|reverse)/.test(name) &&
			typeof (target as Record<string, unknown>)[name] === 'function'
	);
}

/** Each egress family, as the objects whose methods it replaces. */
const EGRESS_FAMILIES: ReadonlyArray<{ label: string; target: object; names: string[] }> = [
	// Every TCP or TLS client (`http(s).request`, `http2`, `tls.connect`,
	// undici's fetch) opens its socket here, before its own DNS lookup.
	{ label: 'net.Socket#', target: net.Socket.prototype, names: ['connect'] },
	{ label: 'dns.', target: dns, names: dnsQueryNames(dns) },
	// The same object as `node:dns/promises`.
	{ label: 'dns.promises.', target: dns.promises, names: dnsQueryNames(dns.promises) },
	{
		label: 'dns.Resolver#',
		target: dns.Resolver.prototype,
		names: dnsQueryNames(dns.Resolver.prototype),
	},
	{
		label: 'dns.promises.Resolver#',
		target: dns.promises.Resolver.prototype,
		names: dnsQueryNames(dns.promises.Resolver.prototype),
	},
	{ label: 'dgram.Socket#', target: dgram.Socket.prototype, names: ['send', 'connect'] },
];

/**
 * Replace every egress entry point with one that records the attempt and
 * throws, synchronously even for the promise APIs. Recording is what fails
 * the test: the SDK turns a transport error into an `{ error }` result, so the
 * throw alone could go unseen. Returns the
 * restore function, and restores itself if installing fails halfway: the
 * builtins are shared with every other file this worker runs.
 * `syncBuiltinESMExports` carries the swap to ESM named imports
 * (`import { lookup } from 'node:dns'`), which otherwise keep the original.
 */
function refuseEgress(): () => void {
	const originals: Array<{ target: Record<string, unknown>; name: string; original: unknown }> = [];
	const restore = (): void => {
		for (const { target, name, original } of originals) target[name] = original;
		syncBuiltinESMExports();
	};
	try {
		for (const { label, target, names } of EGRESS_FAMILIES) {
			const methods = target as Record<string, unknown>;
			for (const name of names) {
				originals.push({ target: methods, name, original: methods[name] });
				methods[name] = function refusedEgress(...args: unknown[]): never {
					egressAttempts.push(`${label}${name}(${describeTarget(args)})`);
					throw new Error(`${EGRESS_BLOCKED}: ${label}${name}`);
				};
			}
		}
		syncBuiltinESMExports();
	} catch (error) {
		restore();
		throw error;
	}
	return restore;
}

/** The first host-like argument: a string, an `{ host }` or either nested in an array. */
function describeTarget(args: readonly unknown[]): string {
	for (const arg of args) {
		if (typeof arg === 'string') return arg;
		if (Array.isArray(arg)) return describeTarget(arg);
		if (arg && typeof arg === 'object' && 'host' in arg) return String(arg.host);
	}
	return '?';
}

/** The attempts so far, cleared, for a test that makes one on purpose. */
function takeEgressAttempts(): string[] {
	return egressAttempts.splice(0);
}

let restoreEgress: (() => void) | undefined;

beforeAll(() => {
	restoreEgress = refuseEgress();
});

afterAll(() => {
	restoreEgress?.();
});

function stubResendApi(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				method: init?.method,
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return Response.json({ id: 're_wire_1' });
		})
	);
}

function onlyRequest(): CapturedRequest {
	expect(requests).toHaveLength(1);
	return requests[0]!;
}

beforeEach(() => {
	requests = [];
	egressAttempts.length = 0;
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	vi.stubEnv('RESEND_API_KEY', 're_synthetic_test_key');
	stubResendApi();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	_resetSendTransportCacheForTests();
	_resetResendClientCacheForTests();
	// Last, so a failure here cannot skip the cleanup above.
	expect(takeEgressAttempts(), 'a request bypassed the stubbed fetch').toEqual([]);
});

// Every host and address below is reserved (`.example`, TEST-NET 192.0.2.0/24),
// so even a broken guard reaches no one.
describe('egress guard (around the stubbed fetch)', () => {
	it('refuses a TCP connect', () => {
		expect(() => net.connect({ host: 'api.owlat.example', port: 443 })).toThrow(EGRESS_BLOCKED);
		expect(takeEgressAttempts()).toEqual(['net.Socket#connect(api.owlat.example)']);
	});

	it('refuses a callback DNS lookup before it resolves, including the ESM binding', () => {
		const callback = vi.fn();
		expect(() => dns.lookup('api.owlat.example', callback)).toThrow(EGRESS_BLOCKED);
		expect(() => esmLookup('api.owlat.example', callback)).toThrow(EGRESS_BLOCKED);
		expect(callback).not.toHaveBeenCalled();
		expect(takeEgressAttempts()).toEqual([
			'dns.lookup(api.owlat.example)',
			'dns.lookup(api.owlat.example)',
		]);
	});

	it('refuses a promise DNS lookup', () => {
		expect(() => dns.promises.lookup('api.owlat.example')).toThrow(EGRESS_BLOCKED);
		expect(takeEgressAttempts()).toEqual(['dns.promises.lookup(api.owlat.example)']);
	});

	it('refuses a query on a callback and a promise Resolver', () => {
		expect(() => new dns.Resolver().resolve4('api.owlat.example', vi.fn())).toThrow(EGRESS_BLOCKED);
		expect(() => new dns.promises.Resolver().resolveTxt('api.owlat.example')).toThrow(
			EGRESS_BLOCKED
		);
		expect(takeEgressAttempts()).toEqual([
			'dns.Resolver#resolve4(api.owlat.example)',
			'dns.promises.Resolver#resolveTxt(api.owlat.example)',
		]);
	});

	it('refuses every query entry point node:dns exposes', () => {
		// The names come from the live module, so a query API a later Node adds
		// is guarded and exercised here without editing this file.
		const owners: ReadonlyArray<[label: string, owner: object]> = [
			['dns.', dns],
			['dns.promises.', dns.promises],
			['dns.Resolver#', new dns.Resolver()],
			['dns.promises.Resolver#', new dns.promises.Resolver()],
		];
		let expected = 0;
		for (const [label, owner] of owners) {
			const { names } = EGRESS_FAMILIES.find((family) => family.label === label)!;
			expect(names, label).toEqual(expect.arrayContaining(['resolve4', 'resolveTxt', 'reverse']));
			for (const name of names) {
				const query = (owner as Record<string, (...args: unknown[]) => unknown>)[name]!;
				expect(() => query.call(owner, '192.0.2.1', 443, vi.fn()), `${label}${name}`).toThrow(
					EGRESS_BLOCKED
				);
				expected += 1;
			}
		}
		expect(takeEgressAttempts()).toHaveLength(expected);
	});

	it('refuses a UDP send and connect', () => {
		const socket = dgram.createSocket('udp4');
		try {
			expect(() => socket.send(Buffer.from('q'), 53, 'ns.owlat.example')).toThrow(EGRESS_BLOCKED);
			expect(() => socket.connect(53, 'ns.owlat.example')).toThrow(EGRESS_BLOCKED);
		} finally {
			socket.close();
		}
		expect(takeEgressAttempts()).toEqual([
			'dgram.Socket#send(ns.owlat.example)',
			'dgram.Socket#connect(ns.owlat.example)',
		]);
	});
});

describe('Resend wire encoding (real SDK, fetch intercepted)', () => {
	it('posts one JSON request to the Resend emails endpoint with the synthetic key', async () => {
		const result = await resendSendProvider.sendEmail(resolveSendTransport('resend'), params);

		expect(result).toEqual({ success: true, id: 're_wire_1' });
		const request = onlyRequest();
		expect(request.method).toBe('POST');
		expect(new URL(request.url).pathname).toBe('/emails');
		expect(request.headers.get('authorization')).toBe('Bearer re_synthetic_test_key');
		expect(request.headers.get('content-type')).toBe('application/json');
	});

	it('encodes attachments with the snake_case content_type and base64 content', async () => {
		await resendSendProvider.sendEmail(resolveSendTransport('resend'), {
			...params,
			attachments: [{ filename: 'report.pdf', content: PDF_BYTES, contentType: 'application/pdf' }],
		});

		const { attachments } = onlyRequest().body;
		expect(attachments).toEqual([
			{
				filename: 'report.pdf',
				content: Buffer.from(PDF_BYTES).toString('base64'),
				content_type: 'application/pdf',
			},
		]);
		// The camelCase input spelling must not reach the wire in its place.
		expect((attachments as Record<string, unknown>[])[0]).not.toHaveProperty('contentType');
	});

	it('sends the governed idempotency key as the Idempotency-Key header', async () => {
		await resendSendProvider.sendEmail(resolveSendTransport('resend'), params, {
			idempotencyKey: 'send_send-row-1',
		});

		const request = onlyRequest();
		expect(request.headers.get('idempotency-key')).toBe('send_send-row-1');
		// A header, not a body field.
		expect(request.body).not.toHaveProperty('idempotencyKey');
		expect(request.body).not.toHaveProperty('idempotency_key');
	});

	it('sends the system-mail caller key as the header, and no header without one', async () => {
		const transport = resolveSendTransport('resend');
		await resendSendProvider.sendEmail(
			transport,
			params,
			resendSendProvider.buildSystemMailExtras!({ idempotencyKey: 'password-reset-1' })
		);
		await resendSendProvider.sendEmail(
			transport,
			params,
			resendSendProvider.buildSystemMailExtras!({ idempotencyKey: undefined })
		);

		expect(requests).toHaveLength(2);
		expect(requests[0]!.headers.get('idempotency-key')).toBe('password-reset-1');
		expect(requests[1]!.headers.has('idempotency-key')).toBe(false);
	});

	it('keeps caller headers in the body, apart from the request headers', async () => {
		await resendSendProvider.sendEmail(
			resolveSendTransport('resend'),
			{ ...params, replyTo: 'reply@owlat.example', headers: { 'List-Unsubscribe': '<u>' } },
			{ idempotencyKey: 'send_send-row-2' }
		);

		const request = onlyRequest();
		expect(request.body).toMatchObject({
			to: 'to@example.com',
			from: 'from@owlat.example',
			subject: 'Quarterly report',
			html: '<p>Attached.</p>',
			text: 'Attached.',
			reply_to: 'reply@owlat.example',
			headers: { 'List-Unsubscribe': '<u>' },
		});
		expect(request.headers.has('list-unsubscribe')).toBe(false);
	});
});
