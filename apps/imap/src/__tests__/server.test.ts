/**
 * Tests for startImapServer — the TLS/TCP bootstrap that owns connection
 * accounting (per-IP cap, global cap, close-decrement) and TLS-vs-plain
 * server selection.
 *
 * `node:tls` and `node:net` are mocked so no real sockets ever open: each
 * mock `createServer` records the connection handler that the production
 * code installs, plus the options/listen calls. Tests then drive fake duplex
 * sockets through it to exercise the accounting branches deterministically.
 * On the TLS flavor a socket first arrives as a raw TCP `connection` on the
 * fake server, where admission happens, and only reaches the captured
 * secure-connection handler if admitted (the "handshake" is instant here;
 * server.handshake.test.ts runs the real one). `../connection.js` is mocked so constructing
 * an ImapConnection per accepted socket is a no-op.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { createServer as tlsCreateServer } from 'tls';
import { createServer as netCreateServer } from 'net';
import { startImapServer } from '../server.js';
import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';

vi.mock('../logger.js', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// ImapConnection touches the real socket in its constructor; stub it so the
// accounting handler can run against a bare fake socket without protocol setup.
const connectionCtor = vi.fn();
vi.mock('../connection.js', () => ({
	ImapConnection: function ImapConnection(...args: unknown[]) {
		connectionCtor(...args);
	},
}));

// The reload wiring is exercised against a real tls.Server in tlsReload.test.ts;
// here it only has to receive the server, the material and the cipher policy.
const startImapTlsReload = vi.fn((..._args: unknown[]) => ({ stop: reloaderStop }));
const reloaderStop = vi.fn();
vi.mock('../tlsReload.js', () => ({
	startImapTlsReload: (...args: unknown[]) => startImapTlsReload(...args),
}));

/**
 * Shared capture for whichever `createServer` the bootstrap calls. The TLS
 * factory receives (options, handler); the TCP factory receives (handler).
 */
interface ServerCapture {
	handler: ((socket: Socket) => void) | null;
	options: Record<string, unknown> | null;
	listen: ReturnType<typeof vi.fn>;
	server: EventEmitter | null;
	flavor: 'tls' | 'tcp' | null;
}

const capture: ServerCapture = {
	handler: null,
	options: null,
	listen: vi.fn(),
	server: null,
	flavor: null,
};

// Stands in for node's own `connection` listener on a tls.Server, the one that
// wraps the raw socket and starts the handshake.
const tlsAccept = vi.fn();

function makeFakeServer() {
	capture.server = Object.assign(new EventEmitter(), { listen: capture.listen });
	return capture.server;
}

vi.mock('tls', () => ({
	createServer: vi.fn((options: Record<string, unknown>, handler: (socket: Socket) => void) => {
		capture.flavor = 'tls';
		capture.options = options;
		capture.handler = handler;
		const server = makeFakeServer();
		server.on('connection', tlsAccept);
		return server;
	}),
}));

vi.mock('net', () => ({
	createServer: vi.fn((handler: (socket: Socket) => void) => {
		capture.flavor = 'tcp';
		capture.handler = handler;
		return makeFakeServer();
	}),
}));

let nextPort = 40_000;

/** Minimal duplex stand-in: records writes/end and emits 'close' on demand. */
class FakeSocket extends EventEmitter {
	written: string[] = [];
	ended = false;
	destroyed = false;
	remotePort = nextPort++;
	localAddress = '127.0.0.1';
	localPort = 993;
	constructor(public remoteAddress: string | undefined) {
		super();
	}
	write(data: string): boolean {
		this.written.push(data);
		return true;
	}
	end(): void {
		this.ended = true;
	}
	destroy(): void {
		this.destroyed = true;
	}
	/** Refused: a BYE on the plaintext listener, a bare destroy before TLS. */
	get refused(): boolean {
		return this.ended || this.destroyed;
	}
	/** Simulate the socket closing (fires the handler's 'close' listener). */
	close(): void {
		this.emit('close');
	}
}

const baseConfig: ImapConfig = {
	port: 993,
	listenAddress: '0.0.0.0',
	tls: null,
	greetingHost: 'imap.test',
	convexUrl: 'https://example.convex.cloud',
	convexAdminKey: 'test-admin-key',
	redisUrl: null,
	maxConnectionsPerIp: 2,
	maxClients: 3,
	idleTimeoutMs: 30 * 60 * 1000,
	authRateLimit: { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 },
	production: false,
	owlatVersion: 'dev',
};

const convex = {} as unknown as ConvexClient;
const limiter = new AuthRateLimiter(null, baseConfig.authRateLimit);

type Connect = (ip: string | undefined) => FakeSocket;

function start(overrides: Partial<ImapConfig> = {}): { handler: Connect } {
	startImapServer({ ...baseConfig, ...overrides }, convex, limiter);
	const handler = capture.handler;
	if (!handler) throw new Error('no connection handler captured');
	return {
		handler: (ip) => {
			const sock = new FakeSocket(ip);
			if (capture.flavor === 'tcp') {
				handler(sock as unknown as Socket);
				return sock;
			}
			// TCP accept, then (if admitted) the completed TLS handshake.
			capture.server!.emit('connection', sock);
			if (!sock.destroyed) handler(sock as unknown as Socket);
			return sock;
		},
	};
}

/** Run a fresh socket from `ip` through the listener. */
function connect(handler: Connect, ip: string | undefined): FakeSocket {
	return handler(ip);
}

beforeEach(() => {
	capture.handler = null;
	capture.options = null;
	capture.flavor = null;
	capture.listen.mockReset();
	capture.server = null;
	connectionCtor.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('startImapServer — server flavor selection', () => {
	it('uses the TLS server with the configured cert/key when tls is set', () => {
		start({ tls: { cert: 'CERT-PEM', key: 'KEY-PEM' } });
		expect(capture.flavor).toBe('tls');
		expect(capture.options).toMatchObject({
			cert: 'CERT-PEM',
			key: 'KEY-PEM',
			minVersion: 'TLSv1.2',
			honorCipherOrder: true,
		});
		expect(typeof capture.options!['ciphers']).toBe('string');
	});

	it('hands the TLS server and its cipher policy to the certificate reloader', () => {
		const tls = { cert: 'CERT-PEM', key: 'KEY-PEM', paths: { cert: '/c.crt', key: '/c.key' } };
		const { stopTlsReload } = startImapServer({ ...baseConfig, tls }, convex, limiter);
		expect(startImapTlsReload).toHaveBeenCalledWith(
			expect.objectContaining({ listen: capture.listen }),
			tls,
			expect.objectContaining({ minVersion: 'TLSv1.2', ciphers: capture.options!['ciphers'] })
		);
		stopTlsReload();
		expect(reloaderStop).toHaveBeenCalledOnce();
	});

	it('binds the plain TCP server outside production when tls is null', () => {
		start({ tls: null });
		expect(capture.flavor).toBe('tcp');
	});

	it('refuses to start in production without TLS', () => {
		expect(() =>
			startImapServer({ ...baseConfig, tls: null, production: true }, convex, limiter)
		).toThrow(/refusing to start in production without TLS/);
	});

	it('listens on the configured port and address', () => {
		start({ tls: { cert: 'c', key: 'k' }, port: 9931, listenAddress: '127.0.0.1' });
		expect(capture.listen).toHaveBeenCalledWith(9931, '127.0.0.1', expect.any(Function));
	});
});

/**
 * PR-62 regression-lock (1): the TLS bootstrap posture. IMAPS is
 * implicit-TLS-only (RFC 8314): a `tls.createServer` so the socket is
 * encrypted before the greeting, TLSv1.2 floor, server cipher
 * preference, an AEAD-only suite, the standards port 993, and a
 * production hard-fail (throw + no listener) when no cert is configured.
 * These are the invariants a careless edit could quietly weaken.
 */
describe('startImapServer — TLS bootstrap posture (PR-62 / RFC 8314)', () => {
	it('builds the listener via the tls flavor of createServer, not net', () => {
		start({ tls: { cert: 'c', key: 'k' } });
		// The encrypted listener must come from node:tls — a net.createServer
		// would leave the greeting + credentials in cleartext.
		expect(capture.flavor).toBe('tls');
	});

	it('floors the negotiated protocol at TLSv1.2 and prefers the server cipher order', () => {
		start({ tls: { cert: 'c', key: 'k' } });
		expect(capture.options!['minVersion']).toBe('TLSv1.2');
		expect(capture.options!['honorCipherOrder']).toBe(true);
	});

	it('advertises only AEAD ciphers — no RC4 / DES / 3DES / CBC / NULL', () => {
		start({ tls: { cert: 'c', key: 'k' } });
		const ciphers = capture.options!['ciphers'] as string;
		const suites = ciphers.split(':');
		expect(suites.length).toBeGreaterThan(0);
		// Every advertised suite is an authenticated-encryption mode (GCM or
		// ChaCha20-Poly1305) — the modes immune to BEAST/Lucky13/SWEET32.
		for (const suite of suites) {
			expect(suite).toMatch(/(GCM|CHACHA20-POLY1305)/);
		}
		// And none of the broken/legacy families appear anywhere in the string.
		expect(ciphers).not.toMatch(/RC4/i);
		expect(ciphers).not.toMatch(/\bDES\b/i);
		expect(ciphers).not.toMatch(/3DES/i);
		expect(ciphers).not.toMatch(/\bCBC\b/i);
		expect(ciphers).not.toMatch(/NULL/i);
	});

	it('defaults to the standards IMAPS port 993', () => {
		// The shipped config binds 993; lock it so a default edit does not
		// silently move the implicit-TLS endpoint.
		expect(baseConfig.port).toBe(993);
		start({ tls: { cert: 'c', key: 'k' } });
		expect(capture.listen).toHaveBeenCalledWith(993, '0.0.0.0', expect.any(Function));
	});

	it('in production with tls:null throws AND never creates any listener', () => {
		// The whole point of the production guard is fail-CLOSED: not only does it
		// throw, it must short-circuit before either createServer is invoked, so
		// no plaintext (or half-built) socket is ever bound.
		vi.mocked(tlsCreateServer).mockClear();
		vi.mocked(netCreateServer).mockClear();
		expect(() =>
			startImapServer({ ...baseConfig, tls: null, production: true }, convex, limiter)
		).toThrow();
		expect(capture.handler).toBeNull();
		expect(tlsCreateServer).not.toHaveBeenCalled();
		expect(netCreateServer).not.toHaveBeenCalled();
	});

	it('with a TLS cert succeeds and installs an accepting connection handler', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, production: true });
		expect(typeof handler).toBe('function');
		// And it actually accepts: the captured handler spins up a connection.
		connect(handler, '10.0.0.9');
		expect(connectionCtor).toHaveBeenCalledTimes(1);
	});

	it('passes tls=true to ImapConnection on the TLS listener (gates LOGIN/AUTH)', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' } });
		connect(handler, '10.0.0.1');
		// ImapConnection(socket, config, convex, rateLimiter, ip, tls)
		const args = connectionCtor.mock.calls[0]!;
		expect(args[5]).toBe(true);
	});

	it('passes tls=false to ImapConnection on the plaintext dev fallback', () => {
		const { handler } = start({ tls: null });
		connect(handler, '10.0.0.1');
		const args = connectionCtor.mock.calls[0]!;
		expect(args[5]).toBe(false);
	});
});

describe('startImapServer — per-IP connection cap', () => {
	it('accepts connections up to maxConnectionsPerIp', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 2 });
		const s1 = connect(handler, '10.0.0.1');
		const s2 = connect(handler, '10.0.0.1');
		expect(s1.refused).toBe(false);
		expect(s2.refused).toBe(false);
		expect(connectionCtor).toHaveBeenCalledTimes(2);
	});

	it('rejects the connection that exceeds the per-IP cap with BYE', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 2 });
		connect(handler, '10.0.0.1');
		connect(handler, '10.0.0.1');
		const over = connect(handler, '10.0.0.1');
		expect(over.refused).toBe(true);
		expect(over.written).toEqual([]);
		// Only the two accepted sockets spun up a connection.
		expect(connectionCtor).toHaveBeenCalledTimes(2);
	});

	it('counts per-IP independently across distinct IPs', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 1,
			maxClients: 99,
		});
		const a = connect(handler, '10.0.0.1');
		const b = connect(handler, '10.0.0.2');
		expect(a.refused).toBe(false);
		expect(b.refused).toBe(false);
		expect(connectionCtor).toHaveBeenCalledTimes(2);
		// A second from IP .1 is over its per-IP cap of 1.
		const aOver = connect(handler, '10.0.0.1');
		expect(aOver.refused).toBe(true);
	});

	it('counts an IPv4 peer once whether it arrives native or IPv4-mapped', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 1,
			maxClients: 99,
		});
		const native = connect(handler, '10.0.0.1');
		const mapped = connect(handler, '::ffff:10.0.0.1');
		expect(native.refused).toBe(false);
		expect(mapped.refused).toBe(true);
		expect(mapped.written).toEqual([]);
	});

	it('counts every IPv6 address of one /64 as one peer', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 1,
			maxClients: 99,
		});
		const first = connect(handler, '2001:db8:1:2::1');
		const sameNet = connect(handler, '2001:db8:1:2:aaaa:bbbb:cccc:dddd');
		const otherNet = connect(handler, '2001:db8:1:3::1');
		expect(first.refused).toBe(false);
		expect(sameNet.refused).toBe(true);
		expect(sameNet.written).toEqual([]);
		expect(otherNet.refused).toBe(false);

		// Closing the first frees the /64's slot for another address in it.
		first.close();
		expect(connect(handler, '2001:db8:1:2::2').refused).toBe(false);
		// The connection itself still sees the peer's full address.
		expect(connectionCtor.mock.calls[0]![4]).toBe('2001:db8:1:2::1');
	});

	it('treats a missing remoteAddress as the "unknown" IP bucket', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 1,
			maxClients: 99,
		});
		const first = connect(handler, undefined);
		const second = connect(handler, undefined);
		expect(first.refused).toBe(false);
		expect(second.refused).toBe(true);
		expect(second.written).toEqual([]);
	});
});

describe('startImapServer — global connection cap', () => {
	it('rejects with the server-limit BYE once totalActive hits maxClients', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 99,
			maxClients: 3,
		});
		// Spread across IPs so the per-IP cap never trips first.
		const a = connect(handler, '10.0.0.1');
		const b = connect(handler, '10.0.0.2');
		const c = connect(handler, '10.0.0.3');
		expect([a, b, c].every((s) => !s.refused)).toBe(true);

		const d = connect(handler, '10.0.0.4');
		expect(d.refused).toBe(true);
		expect(d.written).toEqual([]);
		expect(connectionCtor).toHaveBeenCalledTimes(3);
	});
});

describe('startImapServer — socket close decrements counters', () => {
	it('frees a per-IP slot when an accepted socket closes', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 1,
			maxClients: 99,
		});
		const first = connect(handler, '10.0.0.1');
		expect(first.refused).toBe(false);

		// At the per-IP cap: a second is rejected.
		const blocked = connect(handler, '10.0.0.1');
		expect(blocked.refused).toBe(true);

		// Close the first; the IP slot frees and a new connection is accepted.
		first.close();
		const reconnect = connect(handler, '10.0.0.1');
		expect(reconnect.refused).toBe(false);
		// 2 successful ImapConnection constructions (first + reconnect).
		expect(connectionCtor).toHaveBeenCalledTimes(2);
	});

	it('frees a global slot when an accepted socket closes', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 99,
			maxClients: 1,
		});
		const first = connect(handler, '10.0.0.1');
		expect(first.refused).toBe(false);

		// Global cap reached: a second IP is still rejected.
		const blocked = connect(handler, '10.0.0.2');
		expect(blocked.refused).toBe(true);
		expect(blocked.written).toEqual([]);

		// Close the first; global slot frees and the next is accepted.
		first.close();
		const reconnect = connect(handler, '10.0.0.2');
		expect(reconnect.refused).toBe(false);
	});

	it('does not let totalActive go negative on repeated close events', () => {
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxConnectionsPerIp: 99,
			maxClients: 2,
		});
		const first = connect(handler, '10.0.0.1');
		// Fire close twice (idempotency / spurious event guard).
		first.close();
		first.close();

		// Should still be able to fill the full global budget afterwards.
		const a = connect(handler, '10.0.0.2');
		const b = connect(handler, '10.0.0.3');
		expect(a.refused).toBe(false);
		expect(b.refused).toBe(false);
	});

	it('passes the resolved IP through to the ImapConnection constructor', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' } });
		connect(handler, '10.0.0.1');
		// ImapConnection(socket, config, convex, rateLimiter, ip)
		expect(connectionCtor).toHaveBeenCalledTimes(1);
		const args = connectionCtor.mock.calls[0]!;
		expect(args[4]).toBe('10.0.0.1');
	});
});

describe('startImapServer — plaintext dev listener refusals', () => {
	it('answers a per-IP refusal with BYE, since no TLS stands in the way', () => {
		const { handler } = start({ tls: null, maxConnectionsPerIp: 1, maxClients: 99 });
		connect(handler, '10.0.0.1');
		const over = connect(handler, '10.0.0.1');
		expect(over.ended).toBe(true);
		expect(over.written.join('')).toContain('Too many connections from this IP');
	});

	it('answers a global refusal with BYE', () => {
		const { handler } = start({ tls: null, maxConnectionsPerIp: 99, maxClients: 1 });
		connect(handler, '10.0.0.1');
		const over = connect(handler, '10.0.0.2');
		expect(over.ended).toBe(true);
		expect(over.written.join('')).toContain('Server connection limit reached');
	});
});

/**
 * A raw TCP peer on 993 that never negotiates TLS must hold a
 * slot and be dropped by a deadline, rather than sit outside both caps.
 */
describe('startImapServer — admission before the TLS handshake', () => {
	/** A raw TCP accept that has not finished (or started) its handshake. */
	function acceptRaw(ip: string): FakeSocket {
		const sock = new FakeSocket(ip);
		capture.server!.emit('connection', sock);
		return sock;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('counts a pending handshake against the caps and never starts TLS for the refused one', () => {
		start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 1, maxClients: 1 });
		const pending = acceptRaw('10.0.0.1');
		const samePeer = acceptRaw('10.0.0.1');
		const otherPeer = acceptRaw('10.0.0.2');
		expect(pending.destroyed).toBe(false);
		expect(samePeer.destroyed).toBe(true);
		expect(otherPeer.destroyed).toBe(true);
		// Only the admitted socket reached node's TLS wrapper.
		expect(tlsAccept).toHaveBeenCalledTimes(1);
		expect(tlsAccept).toHaveBeenCalledWith(pending);
		expect(connectionCtor).not.toHaveBeenCalled();

		// A handshake that ends (failed, refused, peer gone) frees the slot.
		pending.close();
		expect(acceptRaw('10.0.0.2').destroyed).toBe(false);
	});

	it('destroys a peer that does not finish the handshake in time, freeing its slot', () => {
		vi.useFakeTimers();
		start({ tls: { cert: 'c', key: 'k' }, maxClients: 1, tlsHandshakeTimeoutMs: 1_000 });
		const silent = acceptRaw('10.0.0.1');
		vi.advanceTimersByTime(999);
		expect(silent.destroyed).toBe(false);
		vi.advanceTimersByTime(1);
		expect(silent.destroyed).toBe(true);
		silent.close();
		expect(acceptRaw('10.0.0.2').destroyed).toBe(false);
	});

	it('defaults the handshake deadline to 30 seconds', () => {
		vi.useFakeTimers();
		start({ tls: { cert: 'c', key: 'k' } });
		const silent = acceptRaw('10.0.0.1');
		vi.advanceTimersByTime(29_999);
		expect(silent.destroyed).toBe(false);
		vi.advanceTimersByTime(1);
		expect(silent.destroyed).toBe(true);
	});

	it('keeps one slot through the handshake and clears the deadline once TLS is up', () => {
		vi.useFakeTimers();
		const { handler } = start({
			tls: { cert: 'c', key: 'k' },
			maxClients: 2,
			tlsHandshakeTimeoutMs: 1_000,
		});
		const session = connect(handler, '10.0.0.1');
		expect(connectionCtor).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5_000);
		expect(session.destroyed).toBe(false);
		// Counted once: one more fits, the next does not.
		expect(acceptRaw('10.0.0.2').destroyed).toBe(false);
		expect(acceptRaw('10.0.0.3').destroyed).toBe(true);
	});

	it('destroys a socket node leaves open after a TLS client error', () => {
		start({ tls: { cert: 'c', key: 'k' } });
		const sock = acceptRaw('10.0.0.1');
		capture.server!.emit('tlsClientError', new Error('ERR_TLS_HANDSHAKE_TIMEOUT'), sock);
		expect(sock.destroyed).toBe(true);
	});

	it('destroys pending handshakes on shutdown', () => {
		const imap = startImapServer({ ...baseConfig, tls: { cert: 'c', key: 'k' } }, convex, limiter);
		const pending = acceptRaw('10.0.0.1');
		imap.closeAllConnections('Server shutting down');
		expect(pending.destroyed).toBe(true);
	});
});
