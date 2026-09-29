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

/** Poll a condition that has no event to wait on (a counter, a mock's calls). */
async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await pred())) {
		if (Date.now() > deadline) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
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

/** A per-IP limiter whose acquire/release are spies the test can steer. */
function limiter(acquire: (peer: SmtpAdmissionPeer) => Promise<boolean>) {
	return {
		acquire: vi.fn(acquire),
		release: vi.fn(async (_peer: SmtpAdmissionPeer) => undefined),
		rejectReply: PER_IP_REJECT,
	};
}

async function start(
	admission: SmtpAdmission,
	overrides: Partial<SmtpListenerOptions> = {}
): Promise<{ listener: SmtpListener; port: number; onConnect: ReturnType<typeof vi.fn> }> {
	const onConnect = vi.fn(() => undefined);
	const started = await startListener({ hostname: 'mx.test', admission, onConnect, ...overrides });
	return { ...started, onConnect };
}

/** Open a raw implicit-TLS client that tolerates being reset. */
function tlsClient(port: number): {
	socket: tls.TLSSocket;
	secured: () => boolean;
	text: () => string;
} {
	// Self-signed fixture cert (see the header of ../smtpTestClient.ts).
	// nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
	const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
	let secured = false;
	let text = '';
	socket.on('error', () => {});
	socket.on('secureConnect', () => {
		secured = true;
	});
	socket.on('data', (chunk: Buffer) => {
		text += chunk.toString();
	});
	return { socket, secured: () => secured, text: () => text };
}

describe('admission on a plaintext / STARTTLS listener', () => {
	it('answers the connection over maxClients with the over-capacity reply after the greeting', async () => {
		const onRefused = vi.fn();
		const { listener, port, onConnect } = await start({
			maxClients: 2,
			overCapacityReply: OVER_CAPACITY,
			onRefused,
		});
		const held = [await Client.connect(port), await Client.connect(port)];
		for (const c of held) await c.waitCode(220);
		await until(() => onConnect.mock.calls.length === 2);

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
		await until(async () => (await openConnections(listener)) === 1);
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
		await until(() => perIp.release.mock.calls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(perIp.release).toHaveBeenCalledTimes(1);
		expect(perIp.release.mock.calls[0]![0]).toEqual(perIp.acquire.mock.calls[0]![0]);
	});

	it('releases exactly once when the peer resets while its acquire is in flight', async () => {
		const verdict = deferred<boolean>();
		const perIp = limiter(() => verdict.promise);
		const { listener, port } = await start({
			maxClients: 10,
			overCapacityReply: OVER_CAPACITY,
			perIp,
		});
		const c = await Client.connect(port);
		await until(() => perIp.acquire.mock.calls.length === 1);
		c.socket.resetAndDestroy();
		await until(async () => (await openConnections(listener)) === 0);
		expect(perIp.release).not.toHaveBeenCalled();

		verdict.resolve(true); // the grant lands after the socket is gone
		await until(() => perIp.release.mock.calls.length === 1);
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
			await until(() => perIp.acquire.mock.calls.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(client.secured()).toBe(false);
			expect(client.text()).toBe('');

			verdict.resolve(true);
			await until(() => client.text().startsWith('220 '));
			expect(client.secured()).toBe(true);

			// The slot is released once the TLS session ends.
			client.socket.write('QUIT\r\n');
			await until(() => perIp.release.mock.calls.length === 1);
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
			await until(() => perIp.acquire.mock.calls.length === 1);
			const over = tlsClient(port);
			await new Promise<void>((resolve) => over.socket.once('close', () => resolve()));
			expect(over.secured()).toBe(false);
			expect(perIp.acquire).toHaveBeenCalledTimes(1);
		} finally {
			first.destroy();
		}
		// The silent pre-handshake socket held a slot and gives it back on close.
		await until(() => perIp.release.mock.calls.length === 1);
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
			await until(() => client.text().startsWith('220 '));
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
			await until(() => perIp.release.mock.calls.length === 1);
		} finally {
			client.socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
