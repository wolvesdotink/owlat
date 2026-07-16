/**
 * L2 TLS integration — STARTTLS upgrade + implicit TLS over REAL sockets.
 *
 * Mirrors the MTA's bannerEhlo + submissionServer TLS coverage: a runtime
 * openssl-generated cert, a plaintext 587-style listener that advertises
 * STARTTLS and upgrades on demand, and an implicit-TLS 465-style listener that
 * is encrypted from the first byte. Asserts the capability list flips across
 * the upgrade and that the negotiated cipher matches the hardened AEAD policy.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createSmtpListener, type SmtpListener } from '../server.js';
import { DEFAULT_SMTP_CIPHERS, resolveTlsConfig } from '../tls.js';
import type { SmtpListenerOptions } from '../types.js';
import { Client, generateCert, startListener, closeAllListeners } from './tlsTestUtil.js';

/** The six ECDHE-AEAD suites the TLS 1.2 policy advertises (the hardened list). */
const AEAD_CIPHERS = new Set(DEFAULT_SMTP_CIPHERS.split(':'));
/**
 * TLS 1.3's fixed AEAD suites. TLS 1.3 does NOT honor the legacy `ciphers`
 * string (it governs ≤ TLS 1.2 only) and reports a `TLS_*` suite name, so the
 * TLS 1.2 policy is asserted on a version-pinned connection and TLS 1.3 gets a
 * separate connectivity check against these names.
 */
const TLS13_AEAD_CIPHERS = new Set([
	'TLS_AES_128_GCM_SHA256',
	'TLS_AES_256_GCM_SHA384',
	'TLS_CHACHA20_POLY1305_SHA256',
]);
let cert: string;
let key: string;

beforeAll(() => {
	const material = generateCert('mx.test');
	cert = material.cert;
	key = material.key;
}, 20000);

async function start(overrides: Partial<SmtpListenerOptions> = {}): Promise<{
	listener: SmtpListener;
	port: number;
}> {
	return startListener({
		hostname: 'mx.test',
		tls: { cert, key },
		auth: {
			mechanisms: ['PLAIN', 'LOGIN'],
			requireTls: true,
			authenticate: (creds) =>
				creds.username === 'good' && creds.password === 'pw'
					? { ok: true, user: 'good' }
					: { ok: false },
		},
		...overrides,
	});
}

afterEach(closeAllListeners);

describe('STARTTLS upgrade over a real socket', () => {
	it('advertises STARTTLS in cleartext EHLO and drops it after the upgrade', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);

		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(c.received).toContain('STARTTLS');
		// AUTH is NOT advertised pre-TLS (requireTls).
		expect(c.received).not.toContain('250-AUTH');
		expect(c.received).not.toMatch(/(^|\n)250 AUTH/);

		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');

		// Fresh EHLO on the encrypted channel: STARTTLS gone, AUTH now present.
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(c.received).not.toContain('STARTTLS');
		expect(c.received).toMatch(/AUTH PLAIN LOGIN/);
		c.end();
	});

	it('negotiates one of the hardened ECDHE-AEAD suites at TLSv1.2', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		// Pin to TLS 1.2 so the negotiated suite comes from the server's `ciphers`
		// list — the only version the legacy cipher string governs.
		await c.startTls('mx.test', 'TLSv1.2');
		// Force a round-trip so the handshake is fully settled.
		c.write('NOOP\r\n');
		await c.waitCode(250);

		const cipher = c.cipher;
		expect(cipher).toBeDefined();
		expect(cipher?.version).toBe('TLSv1.2');
		expect(AEAD_CIPHERS.has(cipher?.name ?? '')).toBe(true);
		c.end();
	});

	it('also negotiates a TLS 1.3 AEAD suite when the client offers it', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');
		c.write('NOOP\r\n');
		await c.waitCode(250);

		const cipher = c.cipher;
		expect(cipher).toBeDefined();
		expect(cipher?.version).toBe('TLSv1.3');
		expect(TLS13_AEAD_CIPHERS.has(cipher?.name ?? '')).toBe(true);
		c.end();
	});

	it('rejects STARTTLS with a parameter (RFC 3207 §4) without upgrading', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS now\r\n');
		await c.waitCode(501);
		// Channel is still plaintext: a fresh EHLO still advertises STARTTLS.
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(c.received).toContain('STARTTLS');
		c.end();
	});

	it('carries a full MAIL/RCPT/DATA transaction over the TLS channel', async () => {
		const messages: Buffer[] = [];
		const { port } = await start({ onData: (m) => void messages.push(m) });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');

		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		c.write('MAIL FROM:<a@a.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('Subject: hi\r\n\r\nover tls\r\n.\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		expect(messages[0]?.toString()).toBe('Subject: hi\r\n\r\nover tls\r\n');
		c.end();
	});

	it('refuses a second STARTTLS once secure', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');
		c.write('STARTTLS\r\n');
		await c.waitCode(503);
		c.end();
	});
});

describe('STARTTLS handshake abandonment (hostile) is bounded', () => {
	it('settles the upgrade and tears down when the peer FINs before the handshake', async () => {
		// A peer that reads the 220 then FINs starts NO TLS handshake, so the
		// TLSSocket fires neither 'secure' nor 'error' — only 'close'. Without the
		// 'close' rejection in upgradeTls the promise never settles, the command
		// loop stays suspended, and the FD + session leak until the ~5 min idle
		// timer. This asserts the loop exits promptly instead.
		const errors: Error[] = [];
		const { port } = await start({ onError: (e) => void errors.push(e) });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		// Clean FIN immediately after the 220, before any ClientHello.
		c.socket.end();
		// The upgrade rejects on 'close' → handleConnection routes it to onError and
		// destroys the socket. If this resolves quickly the leak is fixed (the idle
		// timer default is far longer than this timeout).
		await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4000 });
		expect(errors.some((e) => /closed while initiating TLS/i.test(e.message))).toBe(true);
	});

	it('rejects the upgrade and tears down when the peer sends non-TLS bytes', async () => {
		// Garbage instead of a ClientHello makes the TLS handshake ERROR; the loop's
		// upgrade catch must route it to onError and tear the connection down.
		const errors: Error[] = [];
		const { port } = await start({ onError: (e) => void errors.push(e) });
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		c.write('this is definitely not a TLS ClientHello\r\n');
		await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 4000 });
		await c.waitClose();
		expect(c.closed).toBe(true);
	});
});

describe('implicit TLS over a real socket', () => {
	it('greets and advertises AUTH (never STARTTLS) from the first byte', async () => {
		const { port } = await start({ implicitTls: true });
		// Pin TLS 1.2 so the hardened `ciphers` list is exercised on the assertion.
		const c = await Client.connectTls(port, 'mx.test', 'TLSv1.2');
		await c.waitCode(220);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(c.received).not.toContain('STARTTLS');
		expect(c.received).toMatch(/AUTH PLAIN LOGIN/);

		const cipher = c.cipher;
		expect(cipher?.version).toBe('TLSv1.2');
		expect(AEAD_CIPHERS.has(cipher?.name ?? '')).toBe(true);
		c.end();
	});

	it('rejects a listener configured for implicit TLS without cert material', () => {
		expect(() => createSmtpListener({ hostname: 'mx.test', implicitTls: true })).toThrow(
			/implicitTls requires tls/
		);
	});
});

describe('resolveTlsConfig applies the hardened defaults', () => {
	it('defaults to TLSv1.2, the AEAD cipher list and honorCipherOrder', () => {
		const resolved = resolveTlsConfig({ cert, key });
		expect(resolved.options.minVersion).toBe('TLSv1.2');
		expect(resolved.options.ciphers).toBe(DEFAULT_SMTP_CIPHERS);
		expect(resolved.options.honorCipherOrder).toBe(true);
		expect(resolved.SNICallback).toBeUndefined();
		expect(resolved.secureContext).toBeDefined();
	});

	it('honors explicit ciphers and an SNI callback', () => {
		const sni = (_name: string, cb: (err: Error | null) => void): void => cb(null);
		const resolved = resolveTlsConfig({
			cert,
			key,
			ciphers: 'ECDHE-RSA-AES128-GCM-SHA256',
			minVersion: 'TLSv1.3',
			honorCipherOrder: false,
			SNICallback: sni,
		});
		expect(resolved.options.ciphers).toBe('ECDHE-RSA-AES128-GCM-SHA256');
		expect(resolved.options.minVersion).toBe('TLSv1.3');
		expect(resolved.options.honorCipherOrder).toBe(false);
		expect(resolved.SNICallback).toBe(sni);
	});
});
