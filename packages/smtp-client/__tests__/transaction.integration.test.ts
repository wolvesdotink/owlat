/**
 * Integration tests for the transaction layer — AUTH, the MAIL/RCPT/DATA
 * envelope, and the {@link sendMessage} one-shot — against a real in-process
 * `smtp-server` (a repo dev dependency) plus a couple of raw `net` peers for the
 * corners smtp-server hides (a mid-DATA socket drop, a MAIL rejection).
 *
 * The four named gate cases live here:
 *   (a) a successful authed send whose body is byte-identical after the server
 *       un-dot-stuffs it;
 *   (b) partial RCPT acceptance (2 of 3) — the send proceeds and every verdict
 *       carries the right per-recipient code;
 *   (c) a mid-DATA drop (phase `data-final`, double-delivery-ambiguous) is
 *       distinguishable from a reject-at-MAIL (phase `mail`, safely retryable);
 *   (d) AUTH on an unsecured, non-loopback connection is refused BY THE CLIENT
 *       before any credential bytes are serialized (the server's onAuth never
 *       fires).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { SMTPServerOptions } from 'smtp-server';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { authenticate, sendEnvelope, sendMessage } from '../src/transaction';
import { isSmtpError } from '../src/errors';
import { VALID_CERT, VALID_KEY } from './certFixtures';

interface RunningServer {
	server: SMTPServer;
	port: number;
}

async function startServer(options: SMTPServerOptions): Promise<RunningServer> {
	const server = new SMTPServer(options);
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

const cleanups: Array<() => void> = [];

/** A raw cleartext SMTP peer answering each command line from `handle`. */
function startRawServer(
	greeting: string,
	handle: (line: string, socket: net.Socket) => string | null
): Promise<number> {
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		socket.write(greeting);
		let buffer = '';
		let inData = false;
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			if (inData) {
				// In the DATA payload the handler decides what to do with the bytes.
				handle('__DATA__', socket);
				return;
			}
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
				if (/^DATA/i.test(line)) {
					inData = true;
				}
				nl = buffer.indexOf('\n');
			}
		});
	});
	server.on('error', () => {});
	cleanups.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
	});
}

// No trailing CRLF: the dot-stuffing terminator (`<CRLF>.<CRLF>`) supplies the
// closing line boundary, so the server's un-dot-stuffed body is byte-identical to
// this exact string. The leading-dot line proves the stuffing round-trips.
const MESSAGE = [
	'From: sender@example.com',
	'To: rcpt@example.net',
	'Subject: hello',
	'',
	'.leading dot line must survive dot-stuffing',
	'ordinary line',
].join('\r\n');

describe('transaction layer — smtp-server integration', () => {
	let running: RunningServer | undefined;

	afterEach(async () => {
		if (running) {
			await stopServer(running.server);
			running = undefined;
		}
		while (cleanups.length > 0) {
			try {
				cleanups.pop()?.();
			} catch {
				// best-effort teardown
			}
		}
	});

	// (a) ── successful authed send, body byte-identical after un-dot-stuffing ──
	it('sends an authenticated message whose body round-trips byte-for-byte', async () => {
		let receivedBody: Buffer | undefined;
		let authedUser: string | undefined;
		running = await startServer({
			secure: true,
			cert: VALID_CERT,
			key: VALID_KEY,
			minVersion: 'TLSv1.2',
			size: 10 * 1024 * 1024,
			authMethods: ['PLAIN', 'LOGIN'],
			onAuth(auth, _session, callback) {
				authedUser = auth.username;
				if (auth.username === 'submituser' && auth.password === 's3cret') {
					callback(null, { user: auth.username });
				} else {
					callback(new Error('bad credentials'));
				}
			},
			onData(stream, _session, callback) {
				const chunks: Buffer[] = [];
				stream.on('data', (c: Buffer) => chunks.push(c));
				stream.on('end', () => {
					receivedBody = Buffer.concat(chunks);
					callback();
				});
			},
		});

		const result = await sendMessage({
			connect: {
				host: '127.0.0.1',
				port: running.port,
				ehloName: 'client.test',
				tlsMode: 'implicit',
				tls: { servername: 'mx.test', ca: VALID_CERT },
			},
			auth: { credentials: { username: 'submituser', password: 's3cret' } },
			envelope: {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: MESSAGE,
			},
		});

		expect(authedUser).toBe('submituser');
		expect(result.accepted.map((v) => v.recipient)).toEqual(['rcpt@example.net']);
		expect(result.rejected).toEqual([]);
		expect(result.response.code).toBeGreaterThanOrEqual(250);
		// smtp-server hands us the message with dot-stuffing already removed. The
		// `.leading` line arriving with exactly ONE leading dot proves our encoder
		// stuffed it and the server un-stuffed it — an un-round-tripped body would
		// show `..leading` or a lost line. We tolerate only a single trailing CRLF,
		// the sole byte a server may append at the dot terminator.
		const received = (receivedBody?.toString('utf8') ?? '').replace(/\r\n$/, '');
		expect(received).toBe(MESSAGE);
		expect(received).toContain('\r\n.leading dot line must survive dot-stuffing\r\n');
		expect(received).not.toContain('..leading');
	});

	// (b) ── partial RCPT acceptance: 2 of 3, verdicts correct per recipient ──
	it('proceeds on partial RCPT acceptance and reports per-recipient verdicts', async () => {
		running = await startServer({
			secure: true,
			cert: VALID_CERT,
			key: VALID_KEY,
			minVersion: 'TLSv1.2',
			authOptional: true,
			onRcptTo(address, _session, callback) {
				if (address.address === 'reject@example.net') {
					const err = new Error('mailbox unavailable') as Error & { responseCode?: number };
					err.responseCode = 550;
					callback(err);
					return;
				}
				callback();
			},
			onData(stream, _session, callback) {
				stream.on('data', () => {});
				stream.on('end', () => callback());
			},
		});

		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port: running.port,
			ehloName: 'client.test',
			tlsMode: 'implicit',
			tls: { servername: 'mx.test', ca: VALID_CERT },
		});
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['ok1@example.net', 'reject@example.net', 'ok2@example.net'],
			data: MESSAGE,
		});
		conn.close();

		expect(result.accepted.map((v) => v.recipient)).toEqual(['ok1@example.net', 'ok2@example.net']);
		expect(result.rejected).toHaveLength(1);
		const bad = result.rejected[0];
		expect(bad?.recipient).toBe('reject@example.net');
		expect(bad?.accepted).toBe(false);
		expect(bad?.replyCode).toBe(550);
	});

	// (d) ── AUTH refused on an unsecured non-loopback connection, before serialize ──
	it('refuses AUTH on an unsecured non-loopback connection before serializing credentials', async () => {
		let onAuthCalled = false;
		running = await startServer({
			secure: false,
			disabledCommands: ['STARTTLS'],
			authOptional: true,
			authMethods: ['PLAIN', 'LOGIN'],
			onAuth(_auth, _session, callback) {
				onAuthCalled = true;
				callback(null, { user: 'x' });
			},
		});

		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port: running.port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		expect(conn.secured).toBe(false);

		let caught: unknown;
		try {
			// `loopback: false` forces the strict rule even though the peer is
			// 127.0.0.1 — this is the client's own refusal, not the server's.
			await authenticate(conn, { username: 'submituser', password: 's3cret' }, { loopback: false });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.secured).toBe(false);
		}
		// The credentials never reached the wire.
		expect(onAuthCalled).toBe(false);
	});
});

// (c) ── mid-DATA drop vs reject-at-MAIL, distinguishable by phase ──
describe('transaction layer — phase-tagged failures against raw peers', () => {
	afterEach(() => {
		while (cleanups.length > 0) {
			try {
				cleanups.pop()?.();
			} catch {
				// best-effort teardown
			}
		}
	});

	async function connectPlain(port: number): Promise<SmtpConnection> {
		return SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
	}

	it('surfaces a reject-at-MAIL as phase `mail` (safely retryable)', async () => {
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw\r\n250 SIZE 1000000\r\n';
			}
			if (/^MAIL FROM/i.test(line)) {
				return '550 5.7.1 sender rejected\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await sendEnvelope(conn, {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: MESSAGE,
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('mail');
			expect(caught.replyCode).toBe(550);
		}
	});

	it('surfaces a mid-DATA socket drop as phase `data-final` (double-delivery-ambiguous)', async () => {
		const port = await startRawServer('220 raw ready\r\n', (line, socket) => {
			if (line === '__DATA__') {
				// The body bytes are arriving — drop the socket mid-stream, before any
				// final reply. This is the ambiguous region: the message may or may not
				// have been queued, so the retry taxonomy must never auto-retry it.
				socket.destroy();
				return null;
			}
			if (/^EHLO/i.test(line)) {
				return '250-raw\r\n250 SIZE 1000000\r\n';
			}
			if (/^DATA/i.test(line)) {
				return '354 go ahead\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await sendEnvelope(conn, {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: MESSAGE,
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			// data / data-final = the never-auto-retried region. Distinguishable from
			// the phase `mail` reject above purely by the discriminant.
			expect(['data', 'data-final']).toContain(caught.phase);
		}
	});
});
