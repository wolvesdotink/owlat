/**
 * Connection admission (`SmtpListenerOptions.admission`) over real sockets.
 *
 * The listener counts every accepted connection itself and runs the per-IP
 * limiter before any caller hook. These cases pin the reply contract on the
 * plaintext/STARTTLS path (greeting, then the refusal, then close; `onConnect`
 * never runs for a refused peer), the fail-open posture, the exactly-once
 * release (including a peer that resets while its acquire is in flight), and
 * the implicit-TLS path, where admission happens before the handshake.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { admitBeforeHandshake, createAdmissionGate } from '../admission.js';
import type { SmtpListener } from '../server.js';
import type { SmtpAdmission, SmtpAdmissionPeer, SmtpListenerOptions } from '../types.js';
import { Client, generateCert, startListener, closeAllListeners } from './tlsTestUtil.js';

const OVER_CAPACITY = { code: 421, text: 'Too many connected clients, try again in a moment' };
const PER_IP_REJECT = { code: 554, text: 'Too many connections from your IP' };

let cert: string;
let key: string;

beforeAll(() => {
	({ cert, key } = generateCert('mx.test'));
}, 20000);

afterEach(closeAllListeners);

/** Counts calls as they happen, so a test can await the n-th one. */
function counter() {
	let count = 0;
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	return {
		hit(): void {
			count += 1;
			for (const waiter of waiters.filter((w) => w.n <= count)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		},
		reached(n: number): Promise<void> {
			if (count >= n) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ n, resolve }));
		},
	};
}

interface Accepted {
	socket: net.Socket;
	/** Resolves once the server side of this connection has closed. */
	closed: Promise<void>;
}

/**
 * Every connection `server` accepts, in order. The listener and the admission
 * gate register their own `'connection'` and `'close'` handlers first, so by
 * the time `closed` resolves here the gate has already settled that socket's
 * slot: every release it will ever make for the socket has been made.
 */
function watchAccepts(server: net.Server): { accepted(index: number): Promise<Accepted> } {
	const sockets: Accepted[] = [];
	const arrivals = counter();
	server.on('connection', (socket: net.Socket) => {
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		sockets.push({ socket, closed });
		arrivals.hit();
	});
	return {
		async accepted(index: number): Promise<Accepted> {
			await arrivals.reached(index + 1);
			return sockets[index]!;
		},
	};
}

/** The listener's live socket count, as the server itself sees it. */
function openConnections(listener: SmtpListener): Promise<number> {
	return new Promise((resolve, reject) => {
		listener.raw.getConnections((err, n) => (err ? reject(err) : resolve(n)));
	});
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A per-IP limiter whose acquire/release are spies the test can steer and await. */
function limiter(acquire: (peer: SmtpAdmissionPeer) => Promise<boolean>) {
	const acquired = counter();
	const released = counter();
	return {
		acquire: vi.fn((peer: SmtpAdmissionPeer) => {
			acquired.hit();
			return acquire(peer);
		}),
		release: vi.fn(async (_peer: SmtpAdmissionPeer) => {
			released.hit();
		}),
		rejectReply: PER_IP_REJECT,
		acquired,
		released,
	};
}

async function start(
	admission: SmtpAdmission,
	overrides: Partial<SmtpListenerOptions> = {}
): Promise<{
	listener: SmtpListener;
	port: number;
	onConnect: ReturnType<typeof vi.fn>;
	connected: ReturnType<typeof counter>;
	accepts: ReturnType<typeof watchAccepts>;
}> {
	const connected = counter();
	const onConnect = vi.fn(() => {
		connected.hit();
		return undefined;
	});
	const started = await startListener({ hostname: 'mx.test', admission, onConnect, ...overrides });
	return { ...started, onConnect, connected, accepts: watchAccepts(started.listener.raw) };
}

/** Open a raw implicit-TLS client that tolerates being reset. */
function tlsClient(port: number): { socket: tls.TLSSocket; secured: () => boolean } {
	// Self-signed fixture cert (see the header of ../smtpTestClient.ts).
	// nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
	const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
	let secured = false;
	socket.on('error', () => {});
	socket.on('secureConnect', () => {
		secured = true;
	});
	return { socket, secured: () => secured };
}

describe('admission on a plaintext / STARTTLS listener', () => {
	it('answers the connection over maxClients with the over-capacity reply after the greeting', async () => {
		const onRefused = vi.fn();
		const { listener, port, onConnect, connected, accepts } = await start({
			maxClients: 2,
			overCapacityReply: OVER_CAPACITY,
			onRefused,
		});
		const held = [await Client.connect(port), await Client.connect(port)];
		for (const c of held) await c.waitCode(220);
		await connected.reached(2);

		const over = await Client.connect(port);
		await over.waitCode(220);
		await over.waitCode(421);
		await over.waitClose();
		expect(over.received).toMatch(/\r\n421 Too many connected clients, try again in a moment\r\n$/);
		expect(onConnect).toHaveBeenCalledTimes(2);
		expect(onRefused).toHaveBeenCalledWith(
			expect.objectContaining({ remoteAddress: '127.0.0.1' }),
			'capacity'
		);

		// A closed connection frees its place under the cap.
		held[0]!.end();
		await (
			await accepts.accepted(0)
		).closed;
		await (
			await accepts.accepted(2)
		).closed;
		expect(await openConnections(listener)).toBe(1);
		const next = await Client.connect(port);
		next.write('EHLO client.test\r\n');
		await next.waitCode(250);
		for (const c of [...held, next]) c.end();
	});

	it('refuses a peer the per-IP limiter rejects, without running onConnect or releasing', async () => {
		const perIp = limiter(async () => false);
		const onRefused = vi.fn();
		const { port, onConnect } = await start({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
			onRefused,
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		await c.waitCode(554);
		await c.waitClose();
		expect(c.received).toContain('554 Too many connections from your IP\r\n');
		expect(onConnect).not.toHaveBeenCalled();
		expect(onRefused).toHaveBeenCalledWith(expect.anything(), 'perIp');
		expect(perIp.acquire).toHaveBeenCalledTimes(1);
		expect(perIp.release).not.toHaveBeenCalled();
	});

	it('does not ask the per-IP limiter about a connection already over maxClients', async () => {
		const perIp = limiter(async () => true);
		const { port } = await start({ maxClients: 0, overCapacityReply: OVER_CAPACITY, perIp });
		const c = await Client.connect(port);
		await c.waitCode(421);
		await c.waitClose();
		expect(perIp.acquire).not.toHaveBeenCalled();
		expect(perIp.release).not.toHaveBeenCalled();
	});

	it.each([
		[
			'rejects',
			async (): Promise<boolean> => {
				throw new Error('redis down');
			},
		],
		[
			'throws synchronously',
			(): Promise<boolean> => {
				throw new Error('redis down');
			},
		],
	])('fails open when acquire %s, reporting the error and owing no release', async (_, acquire) => {
		const perIp = limiter(acquire);
		const onError = vi.fn();
		const { port, onConnect, accepts } = await start(
			{ maxClients: 10, overCapacityReply: OVER_CAPACITY, perIp },
			{ onError }
		);
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(onConnect).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }));
		c.write('QUIT\r\n');
		await c.waitClose();
		await (
			await accepts.accepted(0)
		).closed;
		expect(perIp.release).not.toHaveBeenCalled();
	});

	it('releases a granted slot exactly once when the connection closes', async () => {
		const perIp = limiter(async () => true);
		const { port, accepts } = await start({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const c = await Client.connect(port);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(perIp.release).not.toHaveBeenCalled();
		c.write('QUIT\r\n');
		await c.waitClose();
		await (
			await accepts.accepted(0)
		).closed;
		expect(perIp.release).toHaveBeenCalledTimes(1);
		expect(perIp.release.mock.calls[0]![0]).toEqual(perIp.acquire.mock.calls[0]![0]);
	});

	it('releases exactly once when the peer resets while its acquire is in flight', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const { listener, port, accepts } = await start({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const c = await Client.connect(port);
		await perIp.acquired.reached(1);
		c.socket.resetAndDestroy();
		await (
			await accepts.accepted(0)
		).closed;
		expect(await openConnections(listener)).toBe(0);
		expect(perIp.release).not.toHaveBeenCalled();

		verdict.resolve(true); // the grant lands after the socket is gone
		// The grant is the only release site left for this socket, and it runs
		// in the same turn as the verdict, so one release means exactly one.
		await perIp.released.reached(1);
		expect(perIp.release).toHaveBeenCalledTimes(1);
	});
});

describe('admission on an implicit-TLS listener', () => {
	const startImplicit = (admission: SmtpAdmission) =>
		start(admission, { tls: { cert, key }, implicitTls: true });

	/**
	 * A bare TLS server gated by {@link admitBeforeHandshake}, with node's own
	 * TLS accept handler (the one that starts the handshake) wrapped in a spy.
	 */
	async function gatedTlsServer(
		perIp: ReturnType<typeof limiter>,
		secureConnection: (socket: tls.TLSSocket) => void,
		deadlineMs?: number
	) {
		const gate = createAdmissionGate(
			{ maxClients: 10, overCapacityReply: OVER_CAPACITY, perIp },
			undefined
		);
		const server = tls.createServer({ cert, key }, secureConnection);
		const [tlsAccept] = server.listeners('connection') as Array<(socket: net.Socket) => void>;
		const handshakeStarted = vi.fn();
		server.removeAllListeners('connection');
		server.on('connection', (socket: net.Socket) => {
			handshakeStarted();
			tlsAccept!.call(server, socket);
		});
		admitBeforeHandshake(server, gate, () => undefined, deadlineMs);
		const accepts = watchAccepts(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as net.AddressInfo;
		return {
			port,
			handshakeStarted,
			accepts,
			close: () => new Promise((resolve) => server.close(resolve)),
		};
	}

	it('holds the handshake until admission resolves, then serves the banner over TLS', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const gated = await gatedTlsServer(perIp, (socket) => {
			socket.on('error', () => {});
			socket.write('220 mx.test ready\r\n');
		});
		const connecting = Client.connectTls(gated.port);
		try {
			// The gate is asking the limiter, and node's TLS handler has not run:
			// no handshake can have started.
			await perIp.acquired.reached(1);
			expect(gated.handshakeStarted).not.toHaveBeenCalled();

			verdict.resolve(true);
			const client = await connecting;
			await client.waitCode(220);
			expect(gated.handshakeStarted).toHaveBeenCalledOnce();

			// The slot is released once the TLS session ends.
			expect(perIp.release).not.toHaveBeenCalled();
			client.end();
			await (
				await gated.accepts.accepted(0)
			).closed;
			expect(perIp.release).toHaveBeenCalledTimes(1);
		} finally {
			await connecting.then((client) => client.end()).catch(() => undefined);
			await gated.close();
		}
	});

	it('serves the banner over TLS once a held verdict admits the socket', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const { port, accepts } = await startImplicit({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const connecting = Client.connectTls(port);
		await perIp.acquired.reached(1);
		verdict.resolve(true);
		const client = await connecting;
		await client.waitCode(220);
		client.write('QUIT\r\n');
		await client.waitClose();
		await (
			await accepts.accepted(0)
		).closed;
		expect(perIp.release).toHaveBeenCalledTimes(1);
	});

	it('destroys a refused socket before any TLS byte, and never releases for it', async () => {
		const perIp = limiter(async () => false);
		const onRefused = vi.fn();
		const { port, onConnect } = await startImplicit({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
			onRefused,
		});
		const client = tlsClient(port);
		await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
		expect(client.secured()).toBe(false);
		expect(onConnect).not.toHaveBeenCalled();
		expect(onRefused).toHaveBeenCalledWith(expect.anything(), 'perIp');
		expect(perIp.release).not.toHaveBeenCalled();
	});

	it('destroys a socket over maxClients without consulting the per-IP limiter', async () => {
		const perIp = limiter(async () => true);
		const { port } = await startImplicit({
			maxClients: 1,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const first = net.connect(port, '127.0.0.1');
		first.on('error', () => {});
		try {
			await perIp.acquired.reached(1);
			const over = tlsClient(port);
			await new Promise<void>((resolve) => over.socket.once('close', () => resolve()));
			expect(over.secured()).toBe(false);
			expect(perIp.acquire).toHaveBeenCalledTimes(1);
		} finally {
			first.destroy();
		}
		// The silent pre-handshake socket held a slot and gives it back on close.
		await perIp.released.reached(1);
	});

	it('fails open on an acquire fault and completes the handshake', async () => {
		const perIp = limiter(async () => {
			throw new Error('redis down');
		});
		const onError = vi.fn();
		const { port, accepts } = await start(
			{ maxClients: 10, overCapacityReply: OVER_CAPACITY, perIp },
			{ tls: { cert, key }, implicitTls: true, onError }
		);
		const client = await Client.connectTls(port);
		await client.waitCode(220);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }));
		client.write('QUIT\r\n');
		await client.waitClose();
		await (
			await accepts.accepted(0)
		).closed;
		expect(perIp.release).not.toHaveBeenCalled();
	});

	it('destroys a socket whose verdict misses the admission deadline, and releases the late grant', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const gated = await gatedTlsServer(
			perIp,
			() => {
				throw new Error('a socket past its deadline must never reach the handshake');
			},
			50
		);
		// Only the admission deadline runs on fake time; the sockets keep real I/O.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const client = tlsClient(gated.port);
		const clientClosed = new Promise<void>((resolve) =>
			client.socket.once('close', () => resolve())
		);
		try {
			const { socket } = await gated.accepts.accepted(0);
			await perIp.acquired.reached(1);
			await vi.advanceTimersByTimeAsync(49);
			expect(socket.destroyed).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(socket.destroyed).toBe(true);
			vi.useRealTimers();
			await clientClosed;
			expect(client.secured()).toBe(false);
			expect(gated.handshakeStarted).not.toHaveBeenCalled();
			verdict.resolve(true);
			await perIp.released.reached(1);
		} finally {
			vi.useRealTimers();
			client.socket.destroy();
			await gated.close();
		}
	});
});
