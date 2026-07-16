/**
 * STARTTLS full state reset (RFC 3207 §4.2 / §6).
 *
 * The upgrade MUST discard everything learned in the plaintext phase: a
 * MAIL FROM (or an EHLO, or an AUTH) issued before STARTTLS must NOT survive
 * it. This drives a real socket: MAIL FROM is accepted in cleartext, the
 * channel is upgraded, and the previously-buffered envelope is proven gone
 * because a bare RCPT TO now fails with "Need MAIL command".
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createSmtpListener, type SmtpListener } from '../server.js';
import type { SmtpListenerOptions, SmtpSession } from '../types.js';
import { Client, generateCert } from './tlsTestUtil.js';

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

describe('STARTTLS discards pre-upgrade state', () => {
	it('a MAIL FROM issued before STARTTLS does not survive the upgrade', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);

		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		c.write('MAIL FROM:<pre@tls.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));

		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');

		// The envelope is gone: RCPT without a fresh MAIL is a bad sequence.
		c.write('RCPT TO:<b@b.test>\r\n');
		await c.waitCode(503);
		expect(c.received).toMatch(/Need MAIL command/);
		c.end();
	});

	it('observes a fully reset session object inside onData after the upgrade', async () => {
		const seen: Array<SmtpSession> = [];
		const { port } = await start({
			onData: (_message, session) => {
				seen.push(session);
			},
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		// Pre-TLS: greet + a sender that must be forgotten.
		c.write('EHLO before.test\r\nMAIL FROM:<pre@tls.test>\r\n');
		await c.waitFor((b) => /250 2\.1\.0/.test(b));

		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');

		// A fresh transaction on the secure channel.
		c.write('EHLO after.test\r\nMAIL FROM:<new@tls.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('body\r\n.\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));

		expect(seen).toHaveLength(1);
		const session = seen[0];
		expect(session?.secure).toBe(true);
		expect(session?.mailFrom?.address).toBe('new@tls.test');
		expect(session?.clientHostname).toBe('after.test');
		c.end();
	});

	it('does not re-send a greeting after the upgrade (RFC 3207 §4.2)', async () => {
		const { port } = await start();
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('STARTTLS\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');
		// startTls() cleared the buffer; nothing should arrive until we prompt.
		await new Promise((r) => setTimeout(r, 100));
		expect(c.received).toBe('');
		c.write('NOOP\r\n');
		await c.waitCode(250);
		c.end();
	});
});
