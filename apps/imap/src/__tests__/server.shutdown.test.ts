/**
 * Shutdown against real sockets: a connected client is told `* BYE`, the
 * listener closes, and the process exits 0 well before the watchdog.
 *
 * The old handler called `server.close(cb)` without ever closing the IMAP
 * sessions. `close` only calls back once every socket has ended, so any
 * connected client (an IDLE session above all) held it until the 10 s timer
 * fired and the process exited 1, without a BYE.
 *
 * Kept apart from server.test.ts, which mocks `net`, `tls` and ImapConnection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import { AuthRateLimiter } from '../rateLimit.js';
import { installImapShutdown, startImapServer, type ImapServerHandle } from '../server.js';

vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const config: ImapConfig = {
	port: 0,
	listenAddress: '127.0.0.1',
	tls: null,
	greetingHost: 'imap.test',
	convexUrl: 'https://example.convex.cloud',
	convexAdminKey: 'test-admin-key',
	redisUrl: null,
	maxConnectionsPerIp: 5,
	maxClients: 5,
	idleTimeoutMs: 60_000,
	authRateLimit: { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 },
};

let imap: ImapServerHandle | null = null;
const clients: Socket[] = [];

afterEach(() => {
	for (const client of clients) client.destroy();
	clients.length = 0;
	if (imap?.server.listening) imap.server.close();
	imap = null;
});

async function startServer(): Promise<{ handle: ImapServerHandle; port: number }> {
	const handle = startImapServer(
		config,
		{} as ConvexClient,
		new AuthRateLimiter(null, config.authRateLimit)
	);
	imap = handle;
	if (!handle.server.listening) await new Promise((r) => handle.server.once('listening', r));
	return { handle, port: (handle.server.address() as AddressInfo).port };
}

interface Client {
	socket: Socket;
	received: () => string;
	/** Resolves once the server has ended the connection (FIN received). */
	ended: Promise<void>;
}

/**
 * Connect and wait for the greeting. `allowHalfOpen` keeps the client's side
 * open after the server ends, like a client that never hangs up by itself.
 */
async function connectClient(port: number): Promise<Client> {
	const socket = connect({ port, host: '127.0.0.1', allowHalfOpen: true });
	clients.push(socket);
	let data = '';
	socket.on('data', (chunk) => {
		data += chunk.toString('utf8');
	});
	const ended = new Promise<void>((resolve) => socket.once('end', () => resolve()));
	await vi.waitFor(() => expect(data).toContain('* OK'));
	return { socket, received: () => data, ended };
}

describe('installImapShutdown', () => {
	it('sends * BYE to every connected client and exits 0', async () => {
		const { handle, port } = await startServer();
		const first = await connectClient(port);
		const second = await connectClient(port);
		const exit = vi.fn();
		const disconnect = vi.fn();

		const shutdown = installImapShutdown(handle, { exit, disconnect, signals: [] });
		await shutdown.shutdown('SIGTERM');
		await Promise.all([first.ended, second.ended]);

		expect(first.received()).toMatch(/\* BYE Server shutting down\r\n$/);
		expect(second.received()).toMatch(/\* BYE Server shutting down\r\n$/);
		expect(handle.server.listening).toBe(false);
		expect(disconnect).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it('exits 0 with no clients connected', async () => {
		const { handle } = await startServer();
		const exit = vi.fn();

		await installImapShutdown(handle, { exit, signals: [] }).shutdown('SIGINT');

		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it('sends the BYE once, even when shutdown and a second close race', async () => {
		const { handle, port } = await startServer();
		const client = await connectClient(port);

		handle.closeAllConnections('Server shutting down');
		handle.closeAllConnections('Server shutting down');
		await client.ended;

		expect(client.received().match(/\* BYE/g)).toHaveLength(1);
	});
});
