/**
 * Integration tests for the connection engine against an in-process
 * `smtp-server` (a repo dev dependency). We drive the REAL handshake — a real
 * TLS socket, a real STARTTLS upgrade, real EHLO parsing — over loopback, so
 * `secured`, the negotiated protocol, and the capability table reflect what
 * actually happened on the wire rather than a mock's say-so.
 *
 * Covered here: implicit TLS (465-style), cleartext-then-STARTTLS (25/587),
 * and a STARTTLS-stripping server combined with `requireTls` failing closed
 * with `tlsCause: 'starttls-unavailable'`. The `secured`-iff-TLS invariant is
 * asserted on the upgrade path (cleartext path is covered in the edge suite).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { SMTPServerOptions } from 'smtp-server';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { isSmtpError } from '../src/errors';
import { VALID_CERT, VALID_KEY } from './certFixtures';

interface RunningServer {
	server: SMTPServer;
	port: number;
}

async function startServer(options: SMTPServerOptions): Promise<RunningServer> {
	const server = new SMTPServer({ authOptional: true, ...options });
	server.on('error', () => {});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	return { server, port };
}

function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('SmtpConnection.connect — smtp-server integration', () => {
	let running: RunningServer | undefined;
	let conn: SmtpConnection | undefined;

	afterEach(async () => {
		if (conn) {
			conn.close();
			conn = undefined;
		}
		if (running) {
			await stopServer(running.server);
			running = undefined;
		}
	});

	it('establishes an implicit-TLS connection and reports secured=true', async () => {
		running = await startServer({
			secure: true,
			cert: VALID_CERT,
			key: VALID_KEY,
			minVersion: 'TLSv1.2',
		});
		conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port: running.port,
			ehloName: 'client.test',
			tlsMode: 'implicit',
			tls: { servername: 'mx.test', ca: VALID_CERT },
		});
		expect(conn.secured).toBe(true);
		expect(conn.tlsProtocol).toMatch(/^TLSv1\.[23]$/);
		expect(conn.greeting.code).toBe(220);
	});

	it('upgrades via STARTTLS and reports secured=true after the upgrade', async () => {
		running = await startServer({
			secure: false,
			cert: VALID_CERT,
			key: VALID_KEY,
			minVersion: 'TLSv1.2',
		});
		conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port: running.port,
			ehloName: 'client.test',
			tlsMode: 'starttls',
			requireTls: true,
			tls: { servername: 'mx.test', ca: VALID_CERT },
		});
		// `secured` must be true IFF the socket is TLS at EHLO-completion time.
		expect(conn.secured).toBe(true);
		expect(conn.tlsProtocol).toMatch(/^TLSv1\.[23]$/);
		// The re-EHLO ran over the secured channel; STARTTLS is no longer offered
		// (smtp-server hides it once the session is already secure).
		expect(conn.capabilities.startTls).toBe(false);
	});

	it('fails closed with starttls-unavailable when a stripping server meets requireTls', async () => {
		// disabledCommands removes STARTTLS from the EHLO advertisement.
		running = await startServer({
			secure: false,
			disabledCommands: ['STARTTLS'],
		});
		let caught: unknown;
		try {
			conn = await SmtpConnection.connect({
				host: '127.0.0.1',
				port: running.port,
				ehloName: 'client.test',
				tlsMode: 'starttls',
				requireTls: true,
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('starttls');
			expect(caught.tlsCause).toBe('starttls-unavailable');
			expect(caught.secured).toBe(false);
		}
	});

	it('stays cleartext when STARTTLS is stripped but not required', async () => {
		running = await startServer({
			secure: false,
			disabledCommands: ['STARTTLS'],
		});
		conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port: running.port,
			ehloName: 'client.test',
			tlsMode: 'starttls',
			requireTls: false,
		});
		expect(conn.secured).toBe(false);
		expect(conn.tlsProtocol).toBeUndefined();
	});
});
