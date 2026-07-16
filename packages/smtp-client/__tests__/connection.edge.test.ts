/**
 * Edge-case tests for the connection engine against raw `net` / `tls` servers on
 * ephemeral loopback ports — the corners a full SMTP server hides: a multiline
 * greeting, a greeting that never arrives, a socket that drops mid-EHLO, and the
 * three certificate-verification failures, each of which must surface its EXACT
 * `tlsCause` derived from Node's error code (never from a message string).
 *
 * The cleartext `secured === false` invariant is asserted here (the TLS side is
 * covered in the smtp-server integration suite).
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { isSmtpError } from '../src/errors';
import { VALID_CERT, VALID_KEY, EXPIRED_CERT, EXPIRED_KEY } from './certFixtures';

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		try {
			fn?.();
		} catch {
			// best-effort teardown
		}
	}
});

/**
 * A raw cleartext SMTP responder. `greeting` is written on connect; each
 * received command line is answered from `handle` (default: 250 OK). Returning
 * `null` from `handle` drops the connection without replying.
 */
function startRawServer(config: {
	greeting: string;
	handle?: (command: string, socket: net.Socket) => string | null;
}): Promise<number> {
	const server = net.createServer((socket) => {
		socket.write(config.greeting);
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				const reply = config.handle ? config.handle(line, socket) : '250 OK\r\n';
				if (reply === null) {
					socket.destroy();
					return;
				}
				socket.write(reply);
				nl = buffer.indexOf('\n');
			}
		});
		socket.on('error', () => {});
	});
	server.on('error', () => {});
	cleanups.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});
}

/** A raw silent server: accepts the TCP connection but never writes anything. */
function startSilentServer(): Promise<number> {
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		// deliberately no greeting
	});
	server.on('error', () => {});
	cleanups.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});
}

/** A raw implicit-TLS server presenting `cert`/`key`; it never speaks SMTP. */
function startTlsServer(cert: string, key: string): Promise<number> {
	const server = tls.createServer({ cert, key, minVersion: 'TLSv1.2' }, (socket) => {
		socket.on('error', () => {});
		socket.write('220 mx.test ready\r\n');
	});
	server.on('tlsClientError', () => {});
	server.on('error', () => {});
	cleanups.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});
}

const EHLO_REPLY = '250-mx.test\r\n250-PIPELINING\r\n250-SIZE 10485760\r\n250 SMTPUTF8\r\n';

describe('SmtpConnection.connect — raw-socket edge cases', () => {
	it('accepts a multiline greeting and completes EHLO in cleartext', async () => {
		const port = await startRawServer({
			greeting: '220-mx.test ESMTP Postfix\r\n220-second banner line\r\n220 ready\r\n',
			handle: (line) => (line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n'),
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		expect(conn.greeting.code).toBe(220);
		expect(conn.greeting.lines).toHaveLength(3);
		// `secured` is false on a cleartext connection at EHLO-completion time.
		expect(conn.secured).toBe(false);
		expect(conn.tlsProtocol).toBeUndefined();
		expect(conn.capabilities.pipelining).toBe(true);
		expect(conn.capabilities.smtpUtf8).toBe(true);
		expect(conn.capabilities.size).toBe(10485760);
	});

	it('times out in the greeting phase when no greeting arrives', async () => {
		const port = await startSilentServer();
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'none',
				timeouts: { greeting: 150 },
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('greeting');
			expect(caught.secured).toBe(false);
		}
	});

	it('surfaces a mid-EHLO disconnect as a phase-tagged SmtpError', async () => {
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			// Drop the socket the moment EHLO arrives — no reply.
			handle: (line) => (line.startsWith('EHLO') ? null : '250 OK\r\n'),
		});
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'none',
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('ehlo');
		}
	});

	it('classifies a self-signed cert as cert-untrusted', async () => {
		const port = await startTlsServer(VALID_CERT, VALID_KEY);
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'implicit',
				// No `ca`: the self-signed leaf cannot be chained to a trust anchor.
				tls: { servername: 'mx.test', rejectUnauthorized: true },
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.tlsCause).toBe('cert-untrusted');
			expect(caught.secured).toBe(false);
		}
	});

	it('classifies a hostname mismatch as cert-host-mismatch', async () => {
		const port = await startTlsServer(VALID_CERT, VALID_KEY);
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'implicit',
				// Trust the cert (ca) but offer a name its SAN does not cover.
				tls: { servername: 'wrong.test', ca: VALID_CERT, rejectUnauthorized: true },
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.tlsCause).toBe('cert-host-mismatch');
		}
	});

	it('classifies an expired cert as cert-expired', async () => {
		const port = await startTlsServer(EXPIRED_CERT, EXPIRED_KEY);
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'implicit',
				// Trust the cert as a CA so expiry is the only remaining failure.
				tls: { servername: 'mx.test', ca: EXPIRED_CERT, rejectUnauthorized: true },
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.tlsCause).toBe('cert-expired');
		}
	});
});
