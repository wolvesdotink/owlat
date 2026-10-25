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

/**
 * Waiters on a count that only grows: `reached(n)` resolves once the count is
 * at least `n`, at once if it already is, so a milestone that happened before
 * the test asked is not missed.
 */
function counter() {
	let count = 0;
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	return {
		bump() {
			count += 1;
			for (const waiter of waiters.filter((w) => count >= w.n)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		},
		reached(n: number): Promise<void> {
			return new Promise<void>((resolve) => {
				if (count >= n) resolve();
				else waiters.push({ n, resolve });
			});
		},
	};
}

/** A spy whose calls can be awaited: `called(n)` resolves on its n-th call. */
function awaitableSpy<A extends unknown[], R>(impl: (...args: A) => R) {
	const calls = counter();
	const spy = vi.fn((...args: A) => {
		try {
			return impl(...args);
		} finally {
			calls.bump();
		}
	});
	return Object.assign(spy, { called: calls.reached });
}

/**
 * Server-side socket closes, counted after the listener's own close handlers
 * (admission's included) have run: installed after the listener, so its
 * `'connection'` handler, and every `'close'` handler that one adds, runs first.
 */
function serverCloses(server: net.Server): (n: number) => Promise<void> {
	const closes = counter();
	server.on('connection', (socket: net.Socket) => socket.once('close', closes.bump));
	return closes.reached;
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
	return {
		acquire: awaitableSpy(acquire),
		release: awaitableSpy(async (_peer: SmtpAdmissionPeer) => undefined),
		rejectReply: PER_IP_REJECT,
	};
}

async function start(admission: SmtpAdmission, overrides: Partial<SmtpListenerOptions> = {}) {
	const onConnect = awaitableSpy(() => undefined);
	const started = await startListener({ hostname: 'mx.test', admission, onConnect, ...overrides });
	return { ...started, onConnect, closed: serverCloses(started.listener.raw) };
}

/** Open a raw implicit-TLS client that tolerates being reset. */
function tlsClient(port: number): {
	socket: tls.TLSSocket;
	secured: () => boolean;
	text: () => string;
	/** Resolves once the 220 banner has arrived; rejects if the socket closes first. */
	banner: () => Promise<void>;
} {
	// Self-signed fixture cert (see the header of ../smtpTestClient.ts).
	// nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
	const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
	let secured = false;
	let closed = false;
	let text = '';
	const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
	const settle = () => {
		const greeted = text.startsWith('220 ');
		if (!greeted && !closed) return;
		for (const waiter of waiters.splice(0)) {
			if (greeted) waiter.resolve();
			else waiter.reject(new Error(`closed before the banner: ${JSON.stringify(text)}`));
		}
	};
	socket.on('error', () => {});
	socket.on('secureConnect', () => {
		secured = true;
	});
	socket.on('data', (chunk: Buffer) => {
		text += chunk.toString();
		settle();
	});
	socket.on('close', () => {
		closed = true;
		settle();
	});
	const banner = () =>
		new Promise<void>((resolve, reject) => {
			waiters.push({ resolve, reject });
			settle();
		});
	return { socket, secured: () => secured, text: () => text, banner };
}

describe('admission on a plaintext / STARTTLS listener', () => {
	it('answers the connection over maxClients with the over-capacity reply after the greeting', async () => {
		const onRefused = vi.fn();
		const { port, onConnect, closed } = await start({
			maxClients: 2,
			overCapacityReply: OVER_CAPACITY,
			onRefused,
		});
		const held = [await Client.connect(port), await Client.connect(port)];
		for (const c of held) await c.waitCode(220);
		await onConnect.called(2);

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
		// The refused connection closed first; the released one is the second close.
		held[0]!.end();
		await closed(2);
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
		const { port, onConnect } = await start(
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
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(perIp.release).not.toHaveBeenCalled();
	});

	it('releases a granted slot exactly once when the connection closes', async () => {
		const perIp = limiter(async () => true);
		const { port } = await start({ maxClients: 10, overCapacityReply: OVER_CAPACITY, perIp });
		const c = await Client.connect(port);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(perIp.release).not.toHaveBeenCalled();
		c.write('QUIT\r\n');
		await c.waitClose();
		await perIp.release.called(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(perIp.release).toHaveBeenCalledTimes(1);
		expect(perIp.release.mock.calls[0]![0]).toEqual(perIp.acquire.mock.calls[0]![0]);
	});

	it('releases exactly once when the peer resets while its acquire is in flight', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const { port, closed } = await start({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const c = await Client.connect(port);
		await perIp.acquire.called(1);
		c.socket.resetAndDestroy();
		await closed(1);
		expect(perIp.release).not.toHaveBeenCalled();

		verdict.resolve(true); // the grant lands after the socket is gone
		await perIp.release.called(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(perIp.release).toHaveBeenCalledTimes(1);
	});
});

describe('admission on an implicit-TLS listener', () => {
	const startImplicit = (admission: SmtpAdmission) =>
		start(admission, { tls: { cert, key }, implicitTls: true });

	it('holds the handshake until admission resolves, then serves the banner over TLS', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const { port } = await startImplicit({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const client = tlsClient(port);
		try {
			await perIp.acquire.called(1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(client.secured()).toBe(false);
			expect(client.text()).toBe('');

			verdict.resolve(true);
			await client.banner();
			expect(client.secured()).toBe(true);

			// The slot is released once the TLS session ends.
			client.socket.write('QUIT\r\n');
			await perIp.release.called(1);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(perIp.release).toHaveBeenCalledTimes(1);
		} finally {
			client.socket.destroy();
		}
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
			await perIp.acquire.called(1);
			const over = tlsClient(port);
			await new Promise<void>((resolve) => over.socket.once('close', () => resolve()));
			expect(over.secured()).toBe(false);
			expect(perIp.acquire).toHaveBeenCalledTimes(1);
		} finally {
			first.destroy();
		}
		// The silent pre-handshake socket held a slot and gives it back on close.
		await perIp.release.called(1);
	});

	it('fails open on an acquire fault and completes the handshake', async () => {
		const perIp = limiter(async () => {
			throw new Error('redis down');
		});
		const onError = vi.fn();
		const { port } = await start(
			{ maxClients: 10, overCapacityReply: OVER_CAPACITY, perIp },
			{ tls: { cert, key }, implicitTls: true, onError }
		);
		const client = tlsClient(port);
		try {
			await client.banner();
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }));
			client.socket.write('QUIT\r\n');
			await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(perIp.release).not.toHaveBeenCalled();
		} finally {
			client.socket.destroy();
		}
	});

	it('destroys a socket whose verdict misses the admission deadline, and releases the late grant', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const gate = createAdmissionGate(
			{ maxClients: 10, overCapacityReply: OVER_CAPACITY, perIp },
			undefined
		);
		const server = tls.createServer({ cert, key }, () => {
			throw new Error('a socket past its deadline must never reach the handshake');
		});
		admitBeforeHandshake(server, gate, () => undefined, 50);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as net.AddressInfo;
		const client = tlsClient(port);
		try {
			await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
			expect(client.secured()).toBe(false);
			verdict.resolve(true);
			await perIp.release.called(1);
		} finally {
			client.socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
