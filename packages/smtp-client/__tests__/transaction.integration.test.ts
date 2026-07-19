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
import { authenticate, sendEnvelope, sendMessage, verify } from '../src/transaction';
import { isSmtpError, isSmtpAbortError } from '../src/errors';
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

	it('cancels a stalled send by destroying the live SMTP socket, surfacing a distinct SmtpAbortError', async () => {
		// Previously this asserted only a generic `/connection closed/` wire error — the
		// exact fail-open Finding 3 fixes: a mid-flight abort closes the socket, so the
		// in-flight read rejected with a wrapped wire SmtpError indistinguishable from a
		// genuine transient failure, letting the retry classifier re-enqueue a cancelled
		// send. It now must surface a recognizable SmtpAbortError instead.
		let peerClosed!: () => void;
		let watchingClose = false;
		const closed = new Promise<void>((resolve) => {
			peerClosed = resolve;
		});
		const port = await startRawServer('220 mx.test ready\r\n', (line, socket) => {
			if (!watchingClose) {
				watchingClose = true;
				socket.once('close', peerClosed);
			}
			if (line.startsWith('EHLO')) return '250 mx.test\r\n';
			if (line === 'DATA') return '354 continue\r\n';
			// Never send the final reply: the client stalls in the data-final read until
			// the abort tears the socket down mid-flight.
			if (line === '__DATA__') return '';
			return '250 OK\r\n';
		});
		const controller = new AbortController();
		const send = sendMessage({
			connect: {
				host: '127.0.0.1',
				port,
				ehloName: 'client.test',
				tlsMode: 'none',
				timeouts: { data: 5_000 },
			},
			envelope: {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: MESSAGE,
			},
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);

		let caught: unknown;
		try {
			await send;
		} catch (err) {
			caught = err;
		}
		await closed;

		// The load-bearing assertion: a mid-flight abort is an identifiable abort, NOT a
		// generic phase SmtpError. SmtpAbortError does not extend SmtpError, carries the
		// `aborted: true` marker, and preserves the underlying wire error on `cause`.
		expect(isSmtpAbortError(caught)).toBe(true);
		expect(isSmtpError(caught)).toBe(false);
		if (isSmtpAbortError(caught)) {
			expect(caught.aborted).toBe(true);
			expect(isSmtpError(caught.cause)).toBe(true);
		}
	});

	it('surfaces a pre-flight abort (signal already aborted) as the same SmtpAbortError', async () => {
		// The other abort path: the signal is already aborted before the transaction
		// runs. It must be the SAME recognizable type as the mid-flight abort so a caller
		// can classify both identically.
		const port = await startRawServer('220 mx.test ready\r\n', (line) => {
			if (line.startsWith('EHLO')) return '250 mx.test\r\n';
			if (line === 'DATA') return '354 continue\r\n';
			if (line === '__DATA__') return '';
			return '250 OK\r\n';
		});
		const controller = new AbortController();
		controller.abort();
		let caught: unknown;
		try {
			await sendMessage({
				connect: { host: '127.0.0.1', port, ehloName: 'client.test', tlsMode: 'none' },
				envelope: { from: 'sender@example.com', to: ['rcpt@example.net'], data: MESSAGE },
				signal: controller.signal,
			});
		} catch (err) {
			caught = err;
		}
		expect(isSmtpAbortError(caught)).toBe(true);
		if (isSmtpAbortError(caught)) {
			expect(caught.aborted).toBe(true);
		}
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
		// Drive against a RAW cleartext peer that DOES advertise AUTH and records
		// every line it receives. This is the only way to detect the regression the
		// gate guards: if the client-side pre-serialization refusal were deleted, the
		// client would happily serialize `AUTH PLAIN <token>` here (the server offers
		// it) and the recorded lines would prove it. smtp-server, by contrast, hides
		// AUTH on an insecure link and refuses it itself, so a hollow assertion passes
		// either way.
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n';
			}
			if (/^AUTH/i.test(line)) {
				// A server that received AUTH would answer — recorded above proves it.
				return '235 2.7.0 authenticated\r\n';
			}
			if (/^QUIT/i.test(line)) {
				return '221 bye\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		expect(conn.secured).toBe(false);
		// The server genuinely offered AUTH, so a serializing client would proceed.
		expect(conn.capabilities.authMechanisms.has('PLAIN')).toBe(true);

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
			// A client-side refusal carries NO reply code; a server 5xx refusal would.
			expect(caught.replyCode).toBeUndefined();
		}
		// The load-bearing assertion: no AUTH command ever reached the wire, so the
		// credentials were never serialized. Deleting the client refusal breaks this.
		expect(received.some((line) => /^AUTH/i.test(line))).toBe(false);
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

	it('preserves a complete 554 written mid-DATA before the server slams the socket', async () => {
		// A hostile server emits a COMPLETE permanent verdict DURING the body stream and
		// immediately closes: the 554 lands in the reader's queue, then the FIN poisons
		// the reader. Previously the client rejected with a generic "socket closed" error
		// carrying NO replyCode — the definitive 5xx verdict was lost and the hard bounce
		// misclassified as an ambiguous data-phase failure. The client must now surface
		// the buffered 554 (with its enhanced code), not the generic close error.
		//
		// To land the reply in the queue-then-poisoned recovery path DETERMINISTICALLY
		// (not the incidental clean-read path), the peer STOPS reading after 354 so the
		// client's large body write backpressures — writePayload is left awaiting `drain`
		// when the peer writes the 554 (queued at the client, no read outstanding) and
		// then destroys the socket, poisoning the reader before any clean read occurs.
		const bigBody = [
			'From: s@example.com',
			'To: r@example.net',
			'',
			'X'.repeat(4 * 1024 * 1024),
		].join('\r\n');
		const server = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.write('220 raw ready\r\n');
			let buffer = '';
			let inData = false;
			socket.on('data', (chunk) => {
				if (inData) {
					return; // body bytes: ignored (see the pause() below)
				}
				buffer += chunk.toString('utf8');
				let nl = buffer.indexOf('\n');
				while (nl !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, '');
					buffer = buffer.slice(nl + 1);
					if (/^EHLO/i.test(line)) {
						socket.write('250-raw\r\n250 SIZE 104857600\r\n');
					} else if (/^DATA/i.test(line)) {
						socket.write('354 go ahead\r\n');
						inData = true;
						// Stop consuming the body so the client's write backpressures, then
						// commit the verdict and slam the socket while writePayload is stalled.
						socket.pause();
						setTimeout(() => {
							socket.write('554 5.7.1 message content rejected\r\n');
							setTimeout(() => socket.destroy(), 20);
						}, 40);
						break;
					} else {
						socket.write('250 OK\r\n');
					}
					nl = buffer.indexOf('\n');
				}
			});
		});
		server.on('error', () => {});
		cleanups.push(() => server.close());
		const port = await new Promise<number>((resolve) => {
			server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await sendEnvelope(conn, {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: bigBody,
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			// The load-bearing assertion: the permanent 5xx verdict survived the close.
			expect(caught.replyCode).toBe(554);
			expect(caught.enhancedCode).toBe('5.7.1');
			expect(['data', 'data-final']).toContain(caught.phase);
		}
	});

	it('does NOT report delivery for a 2xx that predates end-of-data (write never finished)', async () => {
		// A misbehaving/hostile server emits a POSITIVE completion DURING the body stream,
		// before it has received <CRLF>.<CRLF>, then slams the socket while the client's
		// large body write is still backpressured. RFC 5321 forbids committing 2xx before
		// end-of-data, so this 250 provably predates the terminator the client never got to
		// flush. The client must NOT treat it as delivered — that would turn a message that
		// was never fully transmitted into a silent "sent" with no bounce. It must instead
		// surface the ambiguous data-phase failure.
		const bigBody = [
			'From: s@example.com',
			'To: r@example.net',
			'',
			'X'.repeat(4 * 1024 * 1024),
		].join('\r\n');
		const server = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.write('220 raw ready\r\n');
			let buffer = '';
			let inData = false;
			socket.on('data', (chunk) => {
				if (inData) {
					return; // body bytes: ignored (see the pause() below)
				}
				buffer += chunk.toString('utf8');
				let nl = buffer.indexOf('\n');
				while (nl !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, '');
					buffer = buffer.slice(nl + 1);
					if (/^EHLO/i.test(line)) {
						socket.write('250-raw\r\n250 SIZE 104857600\r\n');
					} else if (/^DATA/i.test(line)) {
						socket.write('354 go ahead\r\n');
						inData = true;
						// Stop consuming the body so the client's write backpressures, then
						// emit a premature 250 and slam the socket before end-of-data arrives.
						socket.pause();
						setTimeout(() => {
							socket.write('250 2.0.0 queued\r\n');
							setTimeout(() => socket.destroy(), 20);
						}, 40);
						break;
					} else {
						socket.write('250 OK\r\n');
					}
					nl = buffer.indexOf('\n');
				}
			});
		});
		server.on('error', () => {});
		cleanups.push(() => server.close());
		const port = await new Promise<number>((resolve) => {
			server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
		});

		const conn = await connectPlain(port);
		let result: unknown;
		let caught: unknown;
		try {
			result = await sendEnvelope(conn, {
				from: 'sender@example.com',
				to: ['rcpt@example.net'],
				data: bigBody,
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		// It must NOT resolve as a delivered send; it must throw the ambiguous failure.
		expect(result).toBeUndefined();
		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('data-final');
			// The premature 250 was NOT laundered into a success verdict.
			expect(caught.replyCode).toBeUndefined();
		}
	});
});

// ── verify() and the AUTH LOGIN path, against raw loopback peers ──
// These peers live on 127.0.0.1, so the client's loopback exception permits
// cleartext AUTH without a secured channel — letting the raw peer script the
// exact 334 continuations the LOGIN state machine needs.
describe('transaction layer — verify() and AUTH LOGIN', () => {
	afterEach(() => {
		while (cleanups.length > 0) {
			try {
				cleanups.pop()?.();
			} catch {
				// best-effort teardown
			}
		}
	});

	it('verify() resolves against a reachable AUTH endpoint with valid credentials', async () => {
		let authToken: string | undefined;
		let quitSeen = false;
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH PLAIN LOGIN\r\n';
			}
			const plain = /^AUTH PLAIN (.+)$/i.exec(line);
			if (plain) {
				authToken = plain[1];
				return '235 2.7.0 authenticated\r\n';
			}
			if (/^QUIT/i.test(line)) {
				quitSeen = true;
				return '221 bye\r\n';
			}
			return '250 OK\r\n';
		});

		await expect(
			verify({
				connect: { host: '127.0.0.1', port, ehloName: 'client.test', tlsMode: 'none' },
				auth: { credentials: { username: 'submituser', password: 's3cret' } },
			})
		).resolves.toBeUndefined();

		// The PLAIN token is base64(`\0user\0pass`); decoding proves the creds were
		// serialized exactly once, and QUIT ran (verify never sends a message).
		expect(Buffer.from(authToken ?? '', 'base64').toString('utf8')).toBe('\0submituser\0s3cret');
		expect(quitSeen).toBe(true);
	});

	it('verify() rejects with phase `auth` on bad credentials', async () => {
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH PLAIN LOGIN\r\n';
			}
			if (/^AUTH PLAIN/i.test(line)) {
				return '535 5.7.8 authentication failed\r\n';
			}
			if (/^QUIT/i.test(line)) {
				return '221 bye\r\n';
			}
			return '250 OK\r\n';
		});

		let caught: unknown;
		try {
			await verify({
				connect: { host: '127.0.0.1', port, ehloName: 'client.test', tlsMode: 'none' },
				auth: { credentials: { username: 'submituser', password: 'wrong' } },
			});
		} catch (err) {
			caught = err;
		}

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBe(535);
			expect(caught.enhancedCode).toBe('5.7.8');
		}
	});

	it('authenticates via AUTH LOGIN, walking both 334 continuations', async () => {
		const received: string[] = [];
		let loginStep = 0;
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				// Advertise only LOGIN so the mechanism selector picks it over PLAIN.
				return '250-raw greets you\r\n250 AUTH LOGIN\r\n';
			}
			if (/^AUTH LOGIN$/i.test(line)) {
				loginStep = 1;
				return '334 VXNlcm5hbWU6\r\n'; // base64("Username:")
			}
			if (loginStep === 1) {
				loginStep = 2;
				return '334 UGFzc3dvcmQ6\r\n'; // base64("Password:")
			}
			if (loginStep === 2) {
				loginStep = 3;
				return '235 2.7.0 authenticated\r\n';
			}
			if (/^QUIT/i.test(line)) {
				return '221 bye\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		await authenticate(conn, { username: 'loginuser', password: 'l0ginpass' });
		conn.close();

		// The two continuation lines carry base64(username) then base64(password).
		const userLine = received[received.indexOf('AUTH LOGIN') + 1];
		const passLine = received[received.indexOf('AUTH LOGIN') + 2];
		expect(Buffer.from(userLine ?? '', 'base64').toString('utf8')).toBe('loginuser');
		expect(Buffer.from(passLine ?? '', 'base64').toString('utf8')).toBe('l0ginpass');
	});

	it('surfaces an AUTH LOGIN challenge rejection as phase `auth`', async () => {
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH LOGIN\r\n';
			}
			if (/^AUTH LOGIN$/i.test(line)) {
				// Refuse at the very first continuation — exercises assertContinuation's
				// non-334 throw branch before any credential bytes are serialized.
				return '504 5.5.4 unrecognized authentication type\r\n';
			}
			if (/^QUIT/i.test(line)) {
				return '221 bye\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await SmtpConnection.connect({
			host: '127.0.0.1',
			port,
			ehloName: 'client.test',
			tlsMode: 'none',
		});
		let caught: unknown;
		try {
			await authenticate(conn, { username: 'loginuser', password: 'l0ginpass' });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBe(504);
		}
	});
});
