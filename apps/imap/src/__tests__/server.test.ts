/**
 * Tests for startImapServer — the TLS/TCP bootstrap that owns connection
 * accounting (per-IP cap, global cap, close-decrement) and TLS-vs-plain
 * server selection.
 *
 * `node:tls` and `node:net` are mocked so no real sockets ever open: each
 * mock `createServer` records the connection handler that the production
 * code installs, plus the options/listen calls. Tests then drive that
 * captured handler with fake duplex sockets to exercise the accounting
 * branches deterministically. `../connection.js` is mocked so constructing
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
	ImapConnection: class {
		constructor(...args: unknown[]) {
			connectionCtor(...args);
		}
	},
}));

/**
 * Shared capture for whichever `createServer` the bootstrap calls. The TLS
 * factory receives (options, handler); the TCP factory receives (handler).
 */
interface ServerCapture {
	handler: ((socket: Socket) => void) | null;
	options: Record<string, unknown> | null;
	listen: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	flavor: 'tls' | 'tcp' | null;
}

const capture: ServerCapture = {
	handler: null,
	options: null,
	listen: vi.fn(),
	on: vi.fn(),
	flavor: null,
};

function makeFakeServer() {
	return {
		listen: capture.listen,
		on: capture.on,
	};
}

vi.mock('tls', () => ({
	createServer: vi.fn(
		(options: Record<string, unknown>, handler: (socket: Socket) => void) => {
			capture.flavor = 'tls';
			capture.options = options;
			capture.handler = handler;
			return makeFakeServer();
		},
	),
}));

vi.mock('net', () => ({
	createServer: vi.fn((handler: (socket: Socket) => void) => {
		capture.flavor = 'tcp';
		capture.handler = handler;
		return makeFakeServer();
	}),
}));

/** Minimal duplex stand-in: records writes/end and emits 'close' on demand. */
class FakeSocket extends EventEmitter {
	written: string[] = [];
	ended = false;
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
};

const convex = {} as unknown as ConvexClient;
const limiter = new AuthRateLimiter(null, baseConfig.authRateLimit);

function start(overrides: Partial<ImapConfig> = {}): {
	handler: (socket: Socket) => void;
} {
	startImapServer({ ...baseConfig, ...overrides }, convex, limiter);
	if (!capture.handler) throw new Error('no connection handler captured');
	return { handler: capture.handler };
}

/** Run a fresh socket from `ip` through the captured accounting handler. */
function connect(
	handler: (socket: Socket) => void,
	ip: string | undefined,
): FakeSocket {
	const sock = new FakeSocket(ip);
	handler(sock as unknown as Socket);
	return sock;
}

beforeEach(() => {
	capture.handler = null;
	capture.options = null;
	capture.flavor = null;
	capture.listen.mockReset();
	capture.on.mockReset();
	connectionCtor.mockReset();
	delete process.env.NODE_ENV;
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
		expect(typeof capture.options!.ciphers).toBe('string');
	});

	it('binds the plain TCP server outside production when tls is null', () => {
		process.env.NODE_ENV = 'development';
		start({ tls: null });
		expect(capture.flavor).toBe('tcp');
	});

	it('refuses to start in production without TLS', () => {
		process.env.NODE_ENV = 'production';
		expect(() => startImapServer({ ...baseConfig, tls: null }, convex, limiter)).toThrow(
			/refusing to start in production without TLS/,
		);
	});

	it('listens on the configured port and address', () => {
		start({ tls: { cert: 'c', key: 'k' }, port: 9931, listenAddress: '127.0.0.1' });
		expect(capture.listen).toHaveBeenCalledWith(
			9931,
			'127.0.0.1',
			expect.any(Function),
		);
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
		expect(capture.options!.minVersion).toBe('TLSv1.2');
		expect(capture.options!.honorCipherOrder).toBe(true);
	});

	it('advertises only AEAD ciphers — no RC4 / DES / 3DES / CBC / NULL', () => {
		start({ tls: { cert: 'c', key: 'k' } });
		const ciphers = capture.options!.ciphers as string;
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
		process.env.NODE_ENV = 'production';
		// The whole point of the production guard is fail-CLOSED: not only does it
		// throw, it must short-circuit before either createServer is invoked, so
		// no plaintext (or half-built) socket is ever bound.
		vi.mocked(tlsCreateServer).mockClear();
		vi.mocked(netCreateServer).mockClear();
		expect(() => startImapServer({ ...baseConfig, tls: null }, convex, limiter)).toThrow();
		expect(capture.handler).toBeNull();
		expect(tlsCreateServer).not.toHaveBeenCalled();
		expect(netCreateServer).not.toHaveBeenCalled();
	});

	it('with a TLS cert succeeds and installs an accepting connection handler', () => {
		process.env.NODE_ENV = 'production';
		const { handler } = start({ tls: { cert: 'c', key: 'k' } });
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
		process.env.NODE_ENV = 'development';
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
		expect(s1.ended).toBe(false);
		expect(s2.ended).toBe(false);
		expect(connectionCtor).toHaveBeenCalledTimes(2);
	});

	it('rejects the connection that exceeds the per-IP cap with BYE', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 2 });
		connect(handler, '10.0.0.1');
		connect(handler, '10.0.0.1');
		const over = connect(handler, '10.0.0.1');
		expect(over.ended).toBe(true);
		expect(over.written.join('')).toContain('Too many connections from this IP');
		// Only the two accepted sockets spun up a connection.
		expect(connectionCtor).toHaveBeenCalledTimes(2);
	});

	it('counts per-IP independently across distinct IPs', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 1, maxClients: 99 });
		const a = connect(handler, '10.0.0.1');
		const b = connect(handler, '10.0.0.2');
		expect(a.ended).toBe(false);
		expect(b.ended).toBe(false);
		expect(connectionCtor).toHaveBeenCalledTimes(2);
		// A second from IP .1 is over its per-IP cap of 1.
		const aOver = connect(handler, '10.0.0.1');
		expect(aOver.ended).toBe(true);
	});

	it('treats a missing remoteAddress as the "unknown" IP bucket', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 1, maxClients: 99 });
		const first = connect(handler, undefined);
		const second = connect(handler, undefined);
		expect(first.ended).toBe(false);
		expect(second.ended).toBe(true);
		expect(second.written.join('')).toContain('Too many connections from this IP');
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
		expect([a, b, c].every((s) => !s.ended)).toBe(true);

		const d = connect(handler, '10.0.0.4');
		expect(d.ended).toBe(true);
		expect(d.written.join('')).toContain('Server connection limit reached');
		expect(connectionCtor).toHaveBeenCalledTimes(3);
	});
});

describe('startImapServer — socket close decrements counters', () => {
	it('frees a per-IP slot when an accepted socket closes', () => {
		const { handler } = start({ tls: { cert: 'c', key: 'k' }, maxConnectionsPerIp: 1, maxClients: 99 });
		const first = connect(handler, '10.0.0.1');
		expect(first.ended).toBe(false);

		// At the per-IP cap: a second is rejected.
		const blocked = connect(handler, '10.0.0.1');
		expect(blocked.ended).toBe(true);

		// Close the first; the IP slot frees and a new connection is accepted.
		first.close();
		const reconnect = connect(handler, '10.0.0.1');
		expect(reconnect.ended).toBe(false);
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
		expect(first.ended).toBe(false);

		// Global cap reached: a second IP is still rejected.
		const blocked = connect(handler, '10.0.0.2');
		expect(blocked.ended).toBe(true);
		expect(blocked.written.join('')).toContain('Server connection limit reached');

		// Close the first; global slot frees and the next is accepted.
		first.close();
		const reconnect = connect(handler, '10.0.0.2');
		expect(reconnect.ended).toBe(false);
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
		expect(a.ended).toBe(false);
		expect(b.ended).toBe(false);
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
