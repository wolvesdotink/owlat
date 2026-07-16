/**
 * L2 TLS integration — STARTTLS upgrade + implicit TLS over REAL sockets.
 *
 * Mirrors the MTA's bannerEhlo + submissionServer TLS coverage: a runtime
 * openssl-generated cert, a plaintext 587-style listener that advertises
 * STARTTLS and upgrades on demand, and an implicit-TLS 465-style listener that
 * is encrypted from the first byte. Asserts the capability list flips across
 * the upgrade and that the negotiated cipher matches the hardened AEAD policy.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createSmtpListener, type SmtpListener } from '../server.js';
import { DEFAULT_SMTP_CIPHERS, resolveTlsConfig } from '../tls.js';
import type { SmtpListenerOptions } from '../types.js';
import { Client, generateCert } from './tlsTestUtil.js';

const AEAD_CIPHERS = new Set(DEFAULT_SMTP_CIPHERS.split(':'));
const active: SmtpListener[] = [];
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
	const listener = createSmtpListener({
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
	active.push(listener);
	await listener.listen(0, '127.0.0.1');
	const addr = listener.address();
	if (!addr || typeof addr === 'string') throw new Error('no address');
	return { listener, port: addr.port };
}

afterEach(async () => {
	while (active.length > 0) {
		const l = active.pop();
		try {
			await l?.close();
		} catch {
			/* already closed */
		}
	}
});

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

	it('negotiates an AEAD ECDHE cipher at TLSv1.2 or better', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');
		// Force a round-trip so the handshake is fully settled.
		c.write('NOOP\r\n');
		await c.waitCode(250);

		const cipher = c.cipher;
		expect(cipher).toBeDefined();
		expect(AEAD_CIPHERS.has(cipher?.name ?? '')).toBe(true);
		expect(['TLSv1.2', 'TLSv1.3']).toContain(cipher?.version);
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

describe('implicit TLS over a real socket', () => {
	it('greets and advertises AUTH (never STARTTLS) from the first byte', async () => {
		const { port } = await start({ implicitTls: true });
		const c = await Client.connectTls(port, 'mx.test');
		await c.waitCode(220);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		expect(c.received).not.toContain('STARTTLS');
		expect(c.received).toMatch(/AUTH PLAIN LOGIN/);

		const cipher = c.cipher;
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
