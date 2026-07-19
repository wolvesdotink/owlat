/**
 * Post-handshake peer verifier (RFC 7672 DANE hook) integration.
 *
 * `tls.verifyPeerCertificate` runs on the freshly-secured socket BEFORE SMTP
 * resumes, on BOTH the implicit-TLS and STARTTLS paths, and — critically — even
 * when `rejectUnauthorized` is false (the DANE-EE case, where WebPKI is
 * deliberately ignored). A verifier that returns an `Error` fails the connection
 * closed with `tlsCause: 'handshake'`; SMTP never resumes over an unauthenticated
 * channel. Driven against a real loopback smtp-server with a self-signed cert.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { SMTPServerOptions } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { SmtpConnection } from '../src/connection';
import { isSmtpError } from '../src/errors';
import { VALID_CERT, VALID_KEY } from './certFixtures';

interface RunningServer {
	server: SMTPServer;
	port: number;
}

async function startServer(options: SMTPServerOptions): Promise<RunningServer> {
	const server = new SMTPServer({ authOptional: true, ...options });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	server.on('error', () => {});
	return { server, port: (server.server.address() as AddressInfo).port };
}

function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('SmtpConnection.connect — post-handshake verifyPeerCertificate', () => {
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

	it('runs after a STARTTLS upgrade and lets a passing verifier through', async () => {
		running = await startServer({ secure: false, cert: VALID_CERT, key: VALID_KEY });
		let sawSecuredSocket = false;
		conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port: running.port,
			ehloName: 'client.test',
			tlsMode: 'starttls',
			requireTls: true,
			tls: {
				// DANE-EE ignores WebPKI: the socket may be self-signed and the verifier
				// still runs. It authenticates the peer itself and returns undefined.
				rejectUnauthorized: false,
				verifyPeerCertificate: (socket: TLSSocket) => {
					sawSecuredSocket = socket.getPeerCertificate().raw.length > 0;
					return undefined;
				},
			},
		});
		expect(conn.secured).toBe(true);
		expect(sawSecuredSocket).toBe(true);
	});

	it('fails closed (tlsCause=handshake) when the STARTTLS verifier rejects', async () => {
		running = await startServer({ secure: false, cert: VALID_CERT, key: VALID_KEY });
		let caught: unknown;
		try {
			conn = await SmtpConnection.connect({
				host: '127.0.0.1',
				port: running.port,
				ehloName: 'client.test',
				tlsMode: 'starttls',
				requireTls: true,
				tls: {
					rejectUnauthorized: false,
					verifyPeerCertificate: () => new Error('TLSA mismatch: no usable association'),
				},
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('starttls');
			expect(caught.tlsCause).toBe('handshake');
		}
	});

	it('runs on the implicit-TLS path and rejects a mismatching cert', async () => {
		running = await startServer({ secure: true, cert: VALID_CERT, key: VALID_KEY });
		let caught: unknown;
		try {
			conn = await SmtpConnection.connect({
				host: '127.0.0.1',
				port: running.port,
				ehloName: 'client.test',
				tlsMode: 'implicit',
				tls: {
					rejectUnauthorized: false,
					verifyPeerCertificate: () => new Error('TLSA mismatch'),
				},
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('connect');
			expect(caught.tlsCause).toBe('handshake');
		}
	});
});
