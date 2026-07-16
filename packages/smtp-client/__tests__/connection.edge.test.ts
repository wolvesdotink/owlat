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
 * Buffer the socket's input, split it on `\n`, strip a trailing `\r`, and answer
 * each complete command line from `handle`. Returning `null` from `handle` drops
 * the connection without replying. Shared by every raw/TLS test server below so
 * the read loop lives in exactly one place.
 */
function attachLineResponder(
	socket: net.Socket,
	handle: (command: string, socket: net.Socket) => string | null
): void {
	let buffer = '';
	socket.on('data', (chunk) => {
		buffer += chunk.toString('utf8');
		let nl = buffer.indexOf('\n');
		while (nl !== -1) {
			const line = buffer.slice(0, nl).replace(/\r$/, '');
			buffer = buffer.slice(nl + 1);
			const reply = handle(line, socket);
			if (reply === null) {
				socket.destroy();
				return;
			}
			socket.write(reply);
			nl = buffer.indexOf('\n');
		}
	});
	socket.on('error', () => {});
}

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
		attachLineResponder(socket, (line, s) =>
			config.handle ? config.handle(line, s) : '250 OK\r\n'
		);
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

/** A raw implicit-TLS server that also completes the greeting + EHLO handshake. */
function startTlsSmtpServer(cert: string, key: string): Promise<number> {
	const server = tls.createServer({ cert, key, minVersion: 'TLSv1.2' }, (socket) => {
		socket.write('220 mx.test ready\r\n');
		attachLineResponder(socket, (line) => (line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n'));
	});
	server.on('tlsClientError', () => {});
	server.on('error', () => {});
	cleanups.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});
}

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

	it('rejects a concurrent read while one is already pending (D5 invariant)', async () => {
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => (line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n'),
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		// First read parks a waiter (the server sends nothing more); the second must
		// reject synchronously rather than clobber the first waiter.
		const first = conn.readReply('mail', 1_000);
		let caught: unknown;
		try {
			await conn.readReply('mail', 1_000);
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('mail');
		}
		// The first read stays alive and eventually times out on its own.
		await expect(first).rejects.toThrow();
	});

	it('command() refuses a second command BEFORE writing while a reply is awaited', async () => {
		const received: string[] = [];
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => {
				received.push(line);
				return line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n';
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		const receivedBeforeGuard = received.length;
		// Park a waiter so the reader is busy; the server sends nothing more.
		const parked = conn.readReply('mail', 1_000);
		let caught: unknown;
		try {
			// Properly framed line: the refusal must come from the busy-guard, not
			// the framing guard, so this genuinely exercises the D5 pre-write check.
			await conn.command('NOOP\r\n', 'rcpt');
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('rcpt');
		}
		// The refused command must never have reached the wire. Give the loopback a
		// tick to have delivered anything that was (wrongly) written.
		await new Promise((r) => setTimeout(r, 50));
		expect(received.length).toBe(receivedBeforeGuard);
		await expect(parked).rejects.toThrow();
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

	it('binds a localAddress on an implicit-TLS connection', async () => {
		// The implicit-TLS + localAddress combination exercises the net-option
		// passthrough on tls.connect (typed via TlsConnectOptions in transport.ts).
		const port = await startTlsSmtpServer(VALID_CERT, VALID_KEY);
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'implicit',
			localAddress: '127.0.0.1',
			tls: { servername: 'mx.test', ca: VALID_CERT },
		});
		cleanups.push(() => conn.close());
		expect(conn.secured).toBe(true);
		expect(conn.tlsProtocol).toMatch(/^TLSv1\.[23]$/);
		expect(conn.rawSocket.localAddress).toBe('127.0.0.1');
		expect(conn.capabilities.pipelining).toBe(true);
	});

	it('rejects a STARTTLS 220 carrying injected trailing plaintext (CVE-2011-0411)', async () => {
		// The server advertises STARTTLS, then answers the STARTTLS command with the
		// 220 AND an injected `250 injected` reply in a SINGLE cleartext write. A
		// MITM would use exactly this to forge the post-TLS capability table. The
		// client must fail closed in the `starttls` phase rather than consume the
		// injected line as the secured re-EHLO reply.
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => {
				if (line.startsWith('EHLO')) {
					return '250-mx.test\r\n250 STARTTLS\r\n';
				}
				if (line.startsWith('STARTTLS')) {
					return '220 go ahead\r\n250 injected\r\n';
				}
				return '250 OK\r\n';
			},
		});
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'starttls',
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('starttls');
			expect(caught.secured).toBe(false);
		}
	});

	it('poisons the reader after a read timeout: a later command() throws instead of consuming a late reply', async () => {
		// The server completes the handshake, then PARKS the next command line
		// without ever replying. The test drives the read timeout itself with an
		// explicit deadline and only writes the late `250 late` AFTER catching that
		// timeout. A live reader would queue that late reply and hand it to the
		// following read as its own answer (stale-reply desync). The wire timeout
		// must instead poison the reader so every later read/command rejects.
		//
		// Determinism: nothing races a real-clock server timer against the client's
		// timeout. The server never replies on its own, the read deadline is an
		// explicit 100ms `readReply` argument, and the late reply is injected by the
		// test only once the timeout has been observed.
		let parkedSocket: net.Socket | undefined;
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line, socket) => {
				if (line.startsWith('EHLO')) {
					return EHLO_REPLY;
				}
				// Park: capture the socket and write nothing, so the client's read
				// deadline is the only thing that can fire.
				parkedSocket = socket;
				return '';
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
			// Default connect() timeouts — the handshake is not time-boxed tightly, so
			// event-loop jitter cannot flake the setup.
		});
		cleanups.push(() => conn.close());
		// Drive the timed-out hop by hand: write the command, then await a read with
		// an explicit 100ms deadline against a server that never answers.
		conn.write('MAIL FROM:<a@test>\r\n', 'mail');
		let timedOut: unknown;
		try {
			await conn.readReply('mail', 100);
		} catch (err) {
			timedOut = err;
		}
		expect(isSmtpError(timedOut)).toBe(true);
		if (isSmtpError(timedOut)) {
			expect(timedOut.phase).toBe('mail');
		}
		// Now — and only now — inject the late reply the parked hop never got, and
		// let it settle so it is queued before the next read.
		expect(parkedSocket).toBeDefined();
		parkedSocket?.write('250 late\r\n');
		await new Promise((r) => setTimeout(r, 50));
		// A subsequent command must reject (poisoned reader), NOT resolve the late
		// `250 late` as its own answer.
		let caught: unknown;
		try {
			await conn.command('RCPT TO:<b@test>\r\n', 'rcpt', false);
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('rcpt');
		}
	});

	it('close() during an in-flight read rejects the parked read instead of hanging it', async () => {
		// A caller that closes the connection on an outer deadline while a reply is
		// awaited must see the parked promise REJECT — not hang forever. close()
		// pauses the reader's socket listeners before destroying the socket, so the
		// destroy can no longer settle the waiter; dispose() must reject it itself.
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => {
				if (line.startsWith('EHLO')) {
					return EHLO_REPLY;
				}
				// Park: never reply, so the read stays in flight until close().
				return '';
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		conn.write('MAIL FROM:<a@test>\r\n', 'mail');
		const parked = conn.readReply('mail', 5_000);
		// Close while the read is in flight; the parked promise must reject.
		conn.close();
		let caught: unknown;
		try {
			await parked;
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('mail');
		}
	});

	it('command() rejects a line with no CRLF terminator before writing (framing guard)', async () => {
		const received: string[] = [];
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => {
				received.push(line);
				return line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n';
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		const receivedBeforeGuard = received.length;
		let caught: unknown;
		try {
			await conn.command('NOOP', 'rcpt');
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('rcpt');
		}
		// The unframed line must never have reached the wire.
		await new Promise((r) => setTimeout(r, 50));
		expect(received.length).toBe(receivedBeforeGuard);
	});

	it('command() rejects a line carrying an interior CRLF before writing (command injection)', async () => {
		const received: string[] = [];
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => {
				received.push(line);
				return line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n';
			},
		});
		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		cleanups.push(() => conn.close());
		const receivedBeforeGuard = received.length;
		let caught: unknown;
		try {
			// A smuggled second command — the exact injection the framing guard exists
			// to stop — must be refused before any byte reaches the wire.
			await conn.command('RSET\r\nMAIL FROM:<attacker@evil>\r\n', 'rcpt');
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('rcpt');
		}
		await new Promise((r) => setTimeout(r, 50));
		expect(received.length).toBe(receivedBeforeGuard);
	});

	it("fails closed when tlsMode 'none' contradicts requireTls", async () => {
		const port = await startRawServer({
			greeting: '220 mx.test ready\r\n',
			handle: (line) => (line.startsWith('EHLO') ? EHLO_REPLY : '250 OK\r\n'),
		});
		let caught: unknown;
		try {
			await SmtpConnection.connect({
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'none',
				requireTls: true,
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('connect');
			expect(caught.secured).toBe(false);
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
