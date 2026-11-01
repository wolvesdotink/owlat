/**
 * Against real sockets: an IMAPS peer is admitted at TCP accept,
 * so a raw connection that never starts TLS holds a slot until the handshake
 * deadline drops it, and a real TLS client still gets a working session that
 * outlives that deadline.
 *
 * Kept apart from server.test.ts, which mocks `net`, `tls` and ImapConnection.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';
import { startImapServer, type ImapServerHandle } from '../server.js';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../../vitest.timeouts';

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let pair: { cert: string; key: string };

beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-imap-handshake-'));
	try {
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'1',
				'-nodes',
				'-subj',
				'/CN=imap.test',
			],
			{ stdio: 'ignore' }
		);
		pair = {
			cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
			key: readFileSync(join(dir, 'key.pem'), 'utf8'),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, PARALLEL_GATE_TIMEOUT_MS);

let imap: ImapServerHandle | null = null;
const clients: Socket[] = [];

afterEach(async () => {
	for (const client of clients) client.destroy();
	clients.length = 0;
	if (imap?.server.listening) {
		imap.closeAllConnections('test over');
		await new Promise((resolve) => imap!.server.close(resolve));
	}
	imap = null;
}, PARALLEL_GATE_TIMEOUT_MS);

type ServerSeams = NonNullable<Parameters<typeof startImapServer>[3]>;

async function startServer(
	handshakeMs: number,
	seams: ServerSeams = {}
): Promise<{ handle: ImapServerHandle; port: number }> {
	const config: ImapConfig = {
		port: 0,
		listenAddress: '127.0.0.1',
		tls: pair,
		greetingHost: 'imap.test',
		convexUrl: 'https://example.convex.cloud',
		convexAdminKey: 'test-admin-key',
		redisUrl: null,
		maxConnectionsPerIp: 1,
		maxClients: 1,
		idleTimeoutMs: 60_000,
		tlsHandshakeTimeoutMs: handshakeMs,
		authRateLimit: { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 },
		production: false,
		owlatVersion: 'dev',
	};
	const handle = startImapServer(
		config,
		{} as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit),
		seams
	);
	imap = handle;
	if (!handle.server.listening) await new Promise((r) => handle.server.once('listening', r));
	return { handle, port: (handle.server.address() as AddressInfo).port };
}

/** A TCP peer that connects and never sends a byte; resolves once connected. */
async function silentPeer(port: number): Promise<{ socket: Socket; closed: Promise<void> }> {
	const socket = connectTcp(port, '127.0.0.1');
	clients.push(socket);
	socket.on('error', () => {});
	const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
	await new Promise((resolve) => socket.once('connect', resolve));
	return { socket, closed };
}

/**
 * The server's side of the next accepted connection, as admission left it:
 * this listener runs after the server's own, so a refused peer is already
 * destroyed here and an admitted one has its handshake deadline armed.
 */
function nextAccepted(handle: ImapServerHandle): Promise<Socket> {
	return new Promise((resolve) => handle.server.once('connection', resolve));
}

/**
 * A real TLS client: collects decrypted lines and lets the test send a command.
 * Rejects if the server resets or closes the connection before the handshake
 * completes, so a refused client fails fast instead of hanging.
 */
async function tlsClient(port: number) {
	const socket = connectTls({
		port,
		host: '127.0.0.1',
		// nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
		rejectUnauthorized: false,
	});
	clients.push(socket);
	// Kept for the socket's lifetime: a later reset must not surface as an
	// unhandled error event.
	let failure: Error | null = null;
	socket.on('error', (err) => {
		failure = err;
	});
	let received = '';
	socket.setEncoding('utf8');
	socket.on('data', (chunk: string) => {
		received += chunk;
	});
	const waitFor = (text: string) =>
		vi.waitFor(() => expect(received).toContain(text), { timeout: 10_000 });
	await new Promise<void>((resolve, reject) => {
		const onClose = () =>
			reject(failure ?? new Error('connection closed before the TLS handshake finished'));
		socket.once('close', onClose);
		socket.once('secureConnect', () => {
			socket.off('close', onClose);
			resolve();
		});
	});
	return { socket, waitFor };
}

/** Connect a TLS client, retrying while the server is still releasing a slot. */
function tlsClientOnceAdmitted(port: number) {
	return vi.waitFor(() => tlsClient(port), { timeout: 10_000, interval: 50 });
}

// Real sockets, real handshakes and an openssl subprocess: give the suite the
// shared budget for tests whose fixed cost grows under a loaded CI runner.
describe(
	'IMAPS admission before the TLS handshake (real sockets)',
	{ timeout: PARALLEL_GATE_TIMEOUT_MS },
	() => {
		it('a pending handshake holds the only slot and a second raw peer is refused', async () => {
			// A deadline no test reaches, so only admission decides what closes.
			const { port } = await startServer(60_000);
			const first = await silentPeer(port);
			// With maxClients = maxConnectionsPerIp = 1 the second raw peer is over
			// both caps and is closed by the server.
			const second = await silentPeer(port);
			await second.closed;
			expect(first.socket.destroyed).toBe(false);

			// A handshake abandoned by the peer frees its slot: a real TLS client
			// then gets an IMAP session.
			first.socket.destroy();
			const client = await tlsClientOnceAdmitted(port);
			await client.waitFor('* OK');
		});

		it('a raw peer that never negotiates is closed at the deadline, freeing its slot', async () => {
			const deadlineMs = 300;
			const { handle, port } = await startServer(deadlineMs);
			// Only the handshake deadline runs on the fake clock; the sockets are real.
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				// The second peer is admitted only if the expired first one let go of
				// the single slot; otherwise it is refused at once.
				for (const peer of ['first', 'next']) {
					const accepted = nextAccepted(handle);
					const { closed } = await silentPeer(port);
					const serverSide = await accepted;
					expect(serverSide.destroyed, `${peer} admitted`).toBe(false);
					await vi.advanceTimersByTimeAsync(deadlineMs - 1);
					expect(serverSide.destroyed, `${peer} open before the deadline`).toBe(false);
					await vi.advanceTimersByTimeAsync(1);
					expect(serverSide.destroyed, `${peer} closed at the deadline`).toBe(true);
					await closed;
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it('a completed handshake keeps its session past the handshake deadline', async () => {
			// The deadline is armed by the test's own clock: it expires when the
			// test says so, not after a real wait.
			const deadlines: Array<{ expire: () => void; isDisarmed: boolean }> = [];
			const { port } = await startServer(2_000, {
				armHandshakeDeadline: (onExpire) => {
					const deadline = {
						isDisarmed: false,
						expire: () => {
							if (!deadline.isDisarmed) onExpire();
						},
					};
					deadlines.push(deadline);
					return () => {
						deadline.isDisarmed = true;
					};
				},
			});
			const client = await tlsClient(port);
			await client.waitFor('* OK');
			// The session started, so the handshake deadline is off.
			expect(deadlines).toHaveLength(1);
			expect(deadlines[0]!.isDisarmed).toBe(true);

			// Its moment comes and goes: the session is not cut, and still answers.
			for (const deadline of deadlines) deadline.expire();
			expect(client.socket.destroyed).toBe(false);
			client.socket.write('a1 NOOP\r\n');
			await client.waitFor('a1 OK');
		});

		it('shutdown destroys a pending handshake so the listener can close', async () => {
			// A deadline the test never reaches, so only the shutdown can close it.
			const { handle, port } = await startServer(60_000);
			const pending = await silentPeer(port);
			handle.closeAllConnections('Server shutting down');
			await pending.closed;
			await new Promise((resolve) => handle.server.close(resolve));
		});
	}
);
