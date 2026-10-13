/**
 * Issue #1325 against real sockets: an IMAPS peer is admitted at TCP accept,
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

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const HANDSHAKE_MS = 500;

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
});

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
});

async function startServer(
	handshakeMs = HANDSHAKE_MS
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
	};
	const handle = startImapServer(
		config,
		{} as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit)
	);
	imap = handle;
	if (!handle.server.listening) await new Promise((r) => handle.server.once('listening', r));
	return { handle, port: (handle.server.address() as AddressInfo).port };
}

/** A TCP peer that connects and never sends a byte; resolves once connected. */
async function silentPeer(port: number): Promise<{ socket: Socket; closed: Promise<number> }> {
	const socket = connectTcp(port, '127.0.0.1');
	clients.push(socket);
	socket.on('error', () => {});
	const opened = Date.now();
	const closed = new Promise<number>((resolve) =>
		socket.once('close', () => resolve(Date.now() - opened))
	);
	await new Promise((resolve) => socket.once('connect', resolve));
	return { socket, closed };
}

/** A real TLS client: collects decrypted lines and lets the test send a command. */
async function tlsClient(port: number) {
	const socket = connectTls({
		port,
		host: '127.0.0.1',
		// nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
		rejectUnauthorized: false,
	});
	clients.push(socket);
	let received = '';
	socket.setEncoding('utf8');
	socket.on('data', (chunk: string) => {
		received += chunk;
	});
	const waitFor = (text: string) =>
		vi.waitFor(() => expect(received).toContain(text), { timeout: 2_000 });
	await new Promise((resolve) => socket.once('secureConnect', resolve));
	return { socket, waitFor };
}

describe('IMAPS admission before the TLS handshake (real sockets)', () => {
	it('a silent raw peer takes the only slot and is dropped at the deadline', async () => {
		const { port } = await startServer();
		const first = await silentPeer(port);
		// With maxClients = maxConnectionsPerIp = 1 the second raw peer is over
		// both caps and is closed straight away, long before any deadline.
		const second = await silentPeer(port);
		await second.closed;
		expect(first.socket.destroyed).toBe(false);
		// The first is closed by the handshake deadline, not left open.
		expect(await first.closed).toBeGreaterThanOrEqual(HANDSHAKE_MS - 50);

		// Its slot is free again: a real TLS client gets an IMAP session.
		const client = await tlsClient(port);
		await client.waitFor('* OK');
	});

	it('a completed handshake keeps its session past the handshake deadline', async () => {
		const { port } = await startServer();
		const client = await tlsClient(port);
		await client.waitFor('* OK');
		await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_MS * 2));
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
});
