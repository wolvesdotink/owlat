/**
 * AUTH: PLAIN/LOGIN, the no-oracle invariant, and the backend call pattern.
 *
 * The security-critical property is D6: EVERY AUTH failure — unsupported
 * mechanism, malformed base64, client cancel, unknown user, wrong password —
 * produces a byte-identical `535 5.7.8` reply, so a probe cannot learn which
 * stage or which field was wrong. AUTH is refused before TLS, accepted after,
 * and the backend `authenticate` hook (which owns throttle/record/clear) is
 * invoked exactly once per well-formed attempt and NEVER for protocol garbage.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { SmtpListener } from '../server.js';
import { performAuth, type SmtpAuthConfig } from '../auth.js';
import type { MutableSmtpSession, SmtpReply, SmtpListenerOptions } from '../types.js';
import {
	Client,
	generateCert,
	plainToken,
	b64,
	startListener,
	closeAllListeners,
} from './tlsTestUtil.js';

const GENERIC_FAILURE = '535 5.7.8 Authentication credentials invalid';
let cert: string;
let key: string;

beforeAll(() => {
	const material = generateCert('mx.test');
	cert = material.cert;
	key = material.key;
}, 20000);

function authConfig(): SmtpAuthConfig {
	return {
		mechanisms: ['PLAIN', 'LOGIN'],
		requireTls: true,
		authenticate: vi.fn((creds) =>
			creds.username === 'good' && creds.password === 'pw'
				? ({ ok: true, user: 'good' } as const)
				: ({ ok: false } as const)
		),
	};
}

async function start(
	auth: SmtpAuthConfig,
	overrides: Partial<SmtpListenerOptions> = {}
): Promise<{
	listener: SmtpListener;
	port: number;
}> {
	return startListener({
		hostname: 'mx.test',
		tls: { cert, key },
		auth,
		...overrides,
	});
}

afterEach(closeAllListeners);

/** Open a connection and upgrade it to TLS, returning a ready secure client. */
async function secureClient(port: number): Promise<Client> {
	const c = await Client.connect(port);
	await c.waitCode(220);
	c.write('STARTTLS\r\n');
	await c.waitCode(220);
	await c.startTls('mx.test');
	return c;
}

/** The final reply line (code + text), trimmed of CRLF, matching one of `codes`. */
function finalLine(buf: string, codes: number[]): string | undefined {
	const re = new RegExp(`(?:^|\\n)(${codes.join('|')}) [^\\r\\n]*`, 'g');
	const matches = buf.match(re);
	return matches?.at(-1)?.replace(/^\n/, '').trim();
}

describe('AUTH pre/post TLS', () => {
	it('refuses AUTH before TLS without invoking the backend', async () => {
		const auth = authConfig();
		const { port } = await start(auth);
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write(`AUTH PLAIN ${plainToken('good', 'pw')}\r\n`);
		await c.waitCode(530);
		expect(auth.authenticate).not.toHaveBeenCalled();
		c.end();
	});

	it('accepts AUTH PLAIN (inline token) after STARTTLS', async () => {
		const auth = authConfig();
		const { port } = await start(auth);
		const c = await secureClient(port);
		c.write(`AUTH PLAIN ${plainToken('good', 'pw')}\r\n`);
		await c.waitCode(235);
		expect(auth.authenticate).toHaveBeenCalledTimes(1);
		c.end();
	});

	it('accepts AUTH LOGIN with the exact base64 challenges after STARTTLS', async () => {
		const auth = authConfig();
		const { port } = await start(auth);
		const c = await secureClient(port);
		c.write('AUTH LOGIN\r\n');
		await c.waitFor((b) => b.includes(`334 ${b64('Username:')}`));
		c.write(`${b64('good')}\r\n`);
		await c.waitFor((b) => b.includes(`334 ${b64('Password:')}`));
		c.write(`${b64('pw')}\r\n`);
		await c.waitCode(235);
		expect(auth.authenticate).toHaveBeenCalledTimes(1);
		c.end();
	});

	it('rejects a second AUTH once authenticated', async () => {
		const auth = authConfig();
		const { port } = await start(auth);
		const c = await secureClient(port);
		c.write(`AUTH PLAIN ${plainToken('good', 'pw')}\r\n`);
		await c.waitCode(235);
		c.write(`AUTH PLAIN ${plainToken('good', 'pw')}\r\n`);
		await c.waitCode(503);
		c.end();
	});
});

describe('no auth oracle — byte-identical failures', () => {
	it('returns the SAME 535 for every failure stage', async () => {
		const auth = authConfig();
		const { port } = await start(auth);

		// Each entry drives one AUTH attempt to failure over its own connection.
		const failures: Array<(c: Client) => Promise<void>> = [
			// Unsupported mechanism.
			async (c) => {
				c.write('AUTH CRAM-MD5\r\n');
			},
			// Malformed base64 PLAIN token (no NUL separators).
			async (c) => {
				c.write('AUTH PLAIN @@@not-base64@@@\r\n');
			},
			// Unknown user (well-formed token).
			async (c) => {
				c.write(`AUTH PLAIN ${plainToken('ghost', 'pw')}\r\n`);
			},
			// Correct user, wrong password.
			async (c) => {
				c.write(`AUTH PLAIN ${plainToken('good', 'nope')}\r\n`);
			},
			// Client cancel mid-exchange.
			async (c) => {
				c.write('AUTH PLAIN\r\n');
				await c.waitFor((b) => /(^|\n)334/.test(b));
				c.write('*\r\n');
			},
			// LOGIN with a bad password field.
			async (c) => {
				c.write('AUTH LOGIN\r\n');
				await c.waitFor((b) => b.includes('334 '));
				c.write(`${b64('good')}\r\n`);
				await c.waitFor((b) => (b.match(/334 /g) ?? []).length >= 2);
				c.write(`${b64('wrong')}\r\n`);
			},
		];

		const replies: string[] = [];
		for (const drive of failures) {
			const c = await secureClient(port);
			await drive(c);
			await c.waitCode(535);
			replies.push(finalLine(c.received, [535]) ?? '');
			c.end();
		}

		// Every failure is byte-identical.
		for (const r of replies) expect(r).toBe(GENERIC_FAILURE);
		expect(new Set(replies).size).toBe(1);
	});

	it('does NOT invoke the backend for protocol-level failures, once for real attempts', async () => {
		const auth = authConfig();
		const { port } = await start(auth);

		// Protocol garbage: backend must not be consulted (throttle not consumed).
		let c = await secureClient(port);
		c.write('AUTH CRAM-MD5\r\n');
		await c.waitCode(535);
		c.end();
		expect(auth.authenticate).toHaveBeenCalledTimes(0);

		c = await secureClient(port);
		c.write('AUTH PLAIN @@@not-base64@@@\r\n');
		await c.waitCode(535);
		c.end();
		expect(auth.authenticate).toHaveBeenCalledTimes(0);

		// Well-formed credential submission: backend consulted exactly once.
		c = await secureClient(port);
		c.write(`AUTH PLAIN ${plainToken('good', 'nope')}\r\n`);
		await c.waitCode(535);
		c.end();
		expect(auth.authenticate).toHaveBeenCalledTimes(1);
	});

	it('allows a retry on the same connection after a failure (no drop, no oracle)', async () => {
		const auth = authConfig();
		const { port } = await start(auth);
		const c = await secureClient(port);
		c.write(`AUTH PLAIN ${plainToken('good', 'nope')}\r\n`);
		await c.waitCode(535);
		c.write(`AUTH PLAIN ${plainToken('good', 'pw')}\r\n`);
		await c.waitCode(235);
		c.end();
	});

	it('bounds a flood of failed AUTH attempts with 421 and closes the connection', async () => {
		const auth = authConfig();
		// A hostile client looping bad credentials (or unsupported mechanisms) must
		// not hold the connection open forever — failed AUTH counts against the
		// bad-command budget, matching `smtp-server`'s unauthenticated-command cap.
		const { port } = await start(auth, { maxBadCommands: 3 });
		const c = await secureClient(port);
		for (let i = 0; i < 3; i++) {
			c.write('AUTH CRAM-MD5\r\n'); // unsupported → generic 535, never reaches backend
			await c.waitCode(535);
		}
		// The third failure exhausts the budget: 421 then socket teardown.
		await c.waitCode(421);
		await c.waitClose();
		expect(c.closed).toBe(true);
		expect(auth.authenticate).not.toHaveBeenCalled();
		c.end();
	});
});

describe('performAuth unit — mechanism handling', () => {
	function makeSession(): MutableSmtpSession {
		return {
			id: 't',
			remoteAddress: '127.0.0.1',
			remotePort: 1,
			localAddress: '127.0.0.1',
			localPort: 25,
			secure: true,
			authenticated: false,
			esmtp: true,
			rcptTo: [],
			state: undefined,
		};
	}

	function fakeAuth(): SmtpAuthConfig {
		return {
			mechanisms: ['PLAIN', 'LOGIN'],
			requireTls: true,
			authenticate: (creds) =>
				creds.username === 'good' && creds.password === 'pw'
					? { ok: true, user: 'good' }
					: { ok: false },
		};
	}

	it('sets session identity on success and returns "ok"', async () => {
		const session = makeSession();
		const writes: SmtpReply[] = [];
		const result = await performAuth({
			mechanism: 'PLAIN',
			initialResponse: plainToken('good', 'pw'),
			session,
			auth: fakeAuth(),
			write: (r) => void writes.push(r),
			readLine: async () => null,
		});
		expect(result).toBe('ok');
		expect(session.authenticated).toBe(true);
		expect(session.user).toBe('good');
		expect(writes).toHaveLength(0); // inline token needs no 334 prompt
	});

	it('returns "closed" when the peer hangs up mid-exchange', async () => {
		const result = await performAuth({
			mechanism: 'LOGIN',
			initialResponse: null,
			session: makeSession(),
			auth: fakeAuth(),
			write: () => {},
			readLine: async () => null,
		});
		expect(result).toBe('closed');
	});

	it('routes a throwing backend hook to onError and fails generically (no escape)', async () => {
		const backendError = new Error('throttle store offline');
		const authenticate = vi.fn(() => {
			throw backendError;
		});
		const errors: Error[] = [];
		const session = makeSession();
		const result = await performAuth({
			mechanism: 'PLAIN',
			initialResponse: plainToken('good', 'pw'),
			session,
			auth: { mechanisms: ['PLAIN', 'LOGIN'], requireTls: true, authenticate },
			write: () => {},
			readLine: async () => null,
			onError: (e) => void errors.push(e),
		});
		// The rejection is caught, surfaced to onError, and downgraded to the same
		// generic failure — never an unhandled rejection that drops the connection
		// with no reply (D6: failures byte-identical regardless of cause).
		expect(result).toBe('fail');
		expect(session.authenticated).toBe(false);
		expect(errors).toEqual([backendError]);
	});

	it('fails generically when a continuation read throws a non-close error', async () => {
		// A collect-phase fault that is NOT a peer disconnect (e.g. the read side
		// throws) must be swallowed into the same generic `fail` — never surfaced as
		// a distinct outcome (no oracle) and never an unhandled rejection.
		const authenticate = vi.fn(() => ({ ok: false }) as const);
		const result = await performAuth({
			mechanism: 'PLAIN',
			initialResponse: null, // forces a 334 continuation read
			session: makeSession(),
			auth: { mechanisms: ['PLAIN', 'LOGIN'], requireTls: true, authenticate },
			write: () => {},
			readLine: async () => {
				throw new Error('reader exploded');
			},
		});
		expect(result).toBe('fail');
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('fails an unsupported mechanism without touching the backend', async () => {
		const authenticate = vi.fn(() => ({ ok: false }) as const);
		const result = await performAuth({
			mechanism: 'CRAM-MD5',
			initialResponse: null,
			session: makeSession(),
			auth: { mechanisms: ['PLAIN', 'LOGIN'], requireTls: true, authenticate },
			write: () => {},
			readLine: async () => null,
		});
		expect(result).toBe('fail');
		expect(authenticate).not.toHaveBeenCalled();
	});
});
