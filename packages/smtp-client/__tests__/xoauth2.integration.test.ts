/**
 * Integration tests for SASL XOAUTH2 (the Google / Microsoft bearer-token AUTH
 * profile, X4) in the transaction layer, driven against raw `net` loopback peers.
 *
 * The peers live on 127.0.0.1 so the client's loopback exception permits cleartext
 * AUTH — letting each peer script the exact 235 / 334-challenge exchange the
 * XOAUTH2 state machine walks, and letting us read back the precise bytes the
 * client put on the wire.
 *
 * The named gate cases live here:
 *   (a) the EXACT XOAUTH2 initial-response encoding
 *       (`user=<u>^Aauth=Bearer <t>^A^A`, base64) — success (235) and both failure
 *       shapes (a 334 challenge, and an outright final-code reject);
 *   (b) an expired-token 334 (`status:401`) → a DISTINCT retryable-after-refresh
 *       error (`authCause: 'token-expired'`); a malformed-request 334
 *       (`status:400`) → a TERMINAL AUTH_FAILED (`authCause: 'credentials-rejected'`);
 *   (c) the PLAIN path is byte-identical to pre-X4 (same initial-response token).
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { authenticate } from '../src/transaction';
import { isSmtpError } from '../src/errors';

const cleanups: Array<() => void> = [];

// A single module-level teardown vitest applies to every test in the file — the
// per-describe copies were byte-identical, so one hoisted hook replaces both.
afterEach(() => {
	while (cleanups.length > 0) {
		try {
			cleanups.pop()?.();
		} catch {
			// best-effort teardown
		}
	}
});

/** A raw cleartext SMTP peer answering each command line from `handle`. */
function startRawServer(
	greeting: string,
	handle: (line: string, socket: net.Socket) => string | null
): Promise<number> {
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		socket.write(greeting);
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
				if (reply !== '') {
					socket.write(reply);
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

async function connectPlain(port: number): Promise<SmtpConnection> {
	return SmtpConnection.connect({
		host: '127.0.0.1',
		port,
		ehloName: 'client.test',
		tlsMode: 'none',
	});
}

/** base64(JSON) body a Google/Microsoft server puts on its XOAUTH2 334 challenge. */
function challenge(status: number): string {
	return Buffer.from(
		JSON.stringify({
			status: String(status),
			schemes: 'Bearer',
			scope: 'https://mail.google.com/',
		}),
		'utf8'
	).toString('base64');
}

describe('transaction layer — SASL XOAUTH2 (X4)', () => {
	// (a) ── exact initial-response encoding, success ──────────────────────────────
	it('serializes the exact XOAUTH2 initial response and completes on 235', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				return '235 2.7.0 authenticated\r\n';
			}
			if (/^QUIT/i.test(line)) {
				return '221 bye\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		await authenticate(conn, { username: 'user@gmail.com', accessToken: 'ya29.TOKEN' });
		conn.close();

		const authLine = received.find((l) => /^AUTH XOAUTH2 /i.test(l));
		expect(authLine).toBeDefined();
		const token = /^AUTH XOAUTH2 (.+)$/i.exec(authLine ?? '')?.[1] ?? '';
		// The wire bytes MUST decode to the SASL XOAUTH2 initial response exactly:
		// `user=<u>^Aauth=Bearer <t>^A^A` (^A = \x01), no extra framing.
		expect(Buffer.from(token, 'base64').toString('utf8')).toBe(
			'user=user@gmail.com\x01auth=Bearer ya29.TOKEN\x01\x01'
		);
	});

	// (a) ── failure shape 1: outright final-code reject (no challenge) ─────────────
	it('treats an outright final-code XOAUTH2 reject as terminal AUTH_FAILED', async () => {
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				return '535 5.7.8 authentication failed\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await authenticate(conn, { username: 'user@gmail.com', accessToken: 'ya29.TOKEN' });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBe(535);
			expect(caught.enhancedCode).toBe('5.7.8');
			expect(caught.authCause).toBe('credentials-rejected');
		}
	});

	// (a) ── failure shape: transient 4xx reject stays retryable (no authCause) ──────
	it('leaves authCause absent on a transient 454 XOAUTH2 reject so it stays retryable', async () => {
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				// RFC 4954 §6: 454 is a TEMPORARY authentication failure, not a permanent
				// account problem — it must not be misfiled as `credentials-rejected`.
				return '454 4.7.0 temporary authentication failure\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await authenticate(conn, { username: 'user@gmail.com', accessToken: 'ya29.TOKEN' });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBe(454);
			// A transient failure carries no terminal-account discriminant; replyCode-based
			// classification governs retryability, exactly as PLAIN/LOGIN do.
			expect(caught.authCause).toBeUndefined();
		}
	});

	// (b) ── expired token: 334(status 401) → empty continuation → distinct retryable
	it('classifies an expired-token 334 as a retryable-after-refresh error', async () => {
		const received: string[] = [];
		let sawInitial = false;
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				sawInitial = true;
				// A 401 (unauthorized) challenge: the bearer token was rejected.
				return `334 ${challenge(401)}\r\n`;
			}
			if (sawInitial && line === '') {
				// The client MUST answer the challenge with an empty line; only then
				// does the server emit its terminal SMTP code.
				return '535 5.7.8 bad token\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await authenticate(conn, { username: 'user@gmail.com', accessToken: 'ya29.EXPIRED' });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBe(535);
			// The distinguishing discriminant: a refresh may fix this. Classifiers act
			// on `.authCause`, never on the log string (W7).
			expect(caught.authCause).toBe('token-expired');
		}
		// The mandatory empty continuation reached the wire, so the socket was left in
		// a defined state rather than desynced.
		expect(received).toContain('');
	});

	// (b) ── malformed request: 334(status 400) → empty continuation → terminal ─────
	it('classifies a malformed-request 334 as a terminal AUTH_FAILED', async () => {
		let sawInitial = false;
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				sawInitial = true;
				return `334 ${challenge(400)}\r\n`;
			}
			if (sawInitial && line === '') {
				return '535 5.7.8 malformed\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await authenticate(conn, { username: 'user@gmail.com', accessToken: 'ya29.BAD' });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBe(535);
			// A 400 (or any non-401) challenge is terminal — refreshing the token loops.
			expect(caught.authCause).toBe('credentials-rejected');
		}
	});

	// (b) ── an unparseable challenge fails toward terminal, never a refresh loop ────
	it('classifies an unparseable 334 challenge as terminal, not retryable', async () => {
		let sawInitial = false;
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				sawInitial = true;
				return '334 this-is-not-base64-json!!!\r\n';
			}
			if (sawInitial && line === '') {
				return '535 5.7.8 nope\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await authenticate(conn, { username: 'user@gmail.com', accessToken: 'ya29.BAD' });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.authCause).toBe('credentials-rejected');
		}
	});

	// (b/W4) ── XOAUTH2 refused on an unsecured non-loopback link before serialize ──
	it('refuses XOAUTH2 on an unsecured non-loopback connection before serializing the token', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				return '235 2.7.0 authenticated\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		expect(conn.secured).toBe(false);
		expect(conn.capabilities.authMechanisms.has('XOAUTH2')).toBe(true);

		let caught: unknown;
		try {
			// `loopback: false` forces the strict "secured only" rule even on 127.0.0.1.
			await authenticate(
				conn,
				{ username: 'user@gmail.com', accessToken: 'ya29.TOKEN' },
				{ loopback: false }
			);
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.secured).toBe(false);
			expect(caught.replyCode).toBeUndefined();
		}
		// The load-bearing assertion: the bearer token never hit the wire.
		expect(received.some((l) => /^AUTH/i.test(l))).toBe(false);
	});

	// A caller mismatch (XOAUTH2 offered, but only a password supplied) fails closed.
	it('refuses XOAUTH2 when no access token was supplied, before serializing', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			// Password credentials, but the caller forces XOAUTH2 — there is no token.
			await authenticate(conn, { username: 'user', password: 'pw' }, { mechanisms: ['XOAUTH2'] });
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
		}
		expect(received.some((l) => /^AUTH/i.test(l))).toBe(false);
	});

	// The reverse mismatch: a password-only mechanism forced while OAuth creds supplied.
	it('refuses a password-only mechanism forced with OAuth credentials, before serializing', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH PLAIN LOGIN XOAUTH2\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			// OAuth credentials, but the caller forces PLAIN — a password-only mechanism
			// has no way to carry a bearer token, so it fails closed before the wire.
			await authenticate(
				conn,
				{ username: 'user@gmail.com', accessToken: 'ya29.TOKEN' },
				{ mechanisms: ['PLAIN'] }
			);
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
		}
		expect(received.some((l) => /^AUTH/i.test(l))).toBe(false);
	});

	// A `\x01` in the token would smuggle an extra SASL field; reject it pre-wire.
	it('rejects a control character in the access token before serializing the SASL frame', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				return '235 2.7.0 authenticated\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			// A `\x01` would inject a second `auth=` field into the SASL blob.
			await authenticate(conn, {
				username: 'user@gmail.com',
				accessToken: 'ya29.TOKEN\x01auth=Bearer evil',
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBeUndefined();
		}
		// The corrupt frame never reached the wire.
		expect(received.some((l) => /^AUTH/i.test(l))).toBe(false);
	});

	// The same guard covers the username field.
	it('rejects a control character in the username before serializing the SASL frame', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH XOAUTH2\r\n';
			}
			if (/^AUTH XOAUTH2/i.test(line)) {
				return '235 2.7.0 authenticated\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		let caught: unknown;
		try {
			await authenticate(conn, {
				username: 'user@gmail.com\x01auth=Bearer evil',
				accessToken: 'ya29.TOKEN',
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('auth');
			expect(caught.replyCode).toBeUndefined();
		}
		expect(received.some((l) => /^AUTH/i.test(l))).toBe(false);
	});
});

// (c) ── PLAIN remains byte-identical to pre-X4 ────────────────────────────────────
describe('transaction layer — PLAIN unchanged by X4', () => {
	it('serializes SASL PLAIN exactly as before when a password is supplied', async () => {
		const received: string[] = [];
		const port = await startRawServer('220 raw ready\r\n', (line) => {
			received.push(line);
			if (/^EHLO/i.test(line)) {
				return '250-raw greets you\r\n250 AUTH PLAIN LOGIN XOAUTH2\r\n';
			}
			if (/^AUTH PLAIN/i.test(line)) {
				return '235 2.7.0 authenticated\r\n';
			}
			return '250 OK\r\n';
		});

		const conn = await connectPlain(port);
		// Password credentials against a server that ALSO offers XOAUTH2: the default
		// order for a password is still PLAIN, LOGIN — XOAUTH2 is never selected.
		await authenticate(conn, { username: 'submituser', password: 's3cret' });
		conn.close();

		const plain = received.find((l) => /^AUTH PLAIN /i.test(l));
		const token = /^AUTH PLAIN (.+)$/i.exec(plain ?? '')?.[1] ?? '';
		expect(Buffer.from(token, 'base64').toString('utf8')).toBe('\0submituser\0s3cret');
		// No XOAUTH2 command was emitted for password credentials.
		expect(received.some((l) => /^AUTH XOAUTH2/i.test(l))).toBe(false);
	});
});
