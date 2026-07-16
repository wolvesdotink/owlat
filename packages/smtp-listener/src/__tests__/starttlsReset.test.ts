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
import type { SmtpListener } from '../server.js';
import type { SmtpListenerOptions, SmtpSession } from '../types.js';
import { Client, generateCert, startListener, closeAllListeners } from './tlsTestUtil.js';

/**
 * The consumed session fields, captured while the callback holds the live
 * session — before the command loop's post-DATA resetTransaction() clears them.
 */
interface SessionSnapshot {
	secure: boolean;
	mailFrom: SmtpSession['mailFrom'];
	clientHostname: string | undefined;
}

function snapshot(session: SmtpSession): SessionSnapshot {
	return {
		secure: session.secure,
		mailFrom: session.mailFrom,
		clientHostname: session.clientHostname,
	};
}

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
		...overrides,
	});
}

afterEach(closeAllListeners);

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

	it('discards plaintext pipelined behind STARTTLS in one segment (injection guard)', async () => {
		// Snapshot the consumed fields INSIDE the callback: the command loop calls
		// resetTransaction() immediately after writing the 250, clearing the live
		// session's mailFrom before the post-await assertion runs (live-session
		// semantics match smtp-server).
		const seen: Array<SessionSnapshot> = [];
		const { port } = await start({
			onData: (_message, session) => {
				seen.push(snapshot(session));
			},
		});
		const c = await Client.connect(port);
		await c.waitCode(220);
		c.write('EHLO client.test\r\n');
		await c.waitCode(250);
		// Pipeline a MAIL FROM in the SAME plaintext segment as STARTTLS: a
		// STARTTLS-injection attacker's plaintext must be dropped with the reader,
		// never replayed as if it arrived over the encrypted channel (RFC 3207 §6).
		c.write('STARTTLS\r\nMAIL FROM:<evil@x.test>\r\n');
		await c.waitCode(220);
		await c.startTls('mx.test');

		// The injected sender is gone: a bare RCPT is a bad sequence.
		c.write('RCPT TO:<b@b.test>\r\n');
		await c.waitCode(503);
		expect(c.received).toMatch(/Need MAIL command/);

		// A fresh transaction over TLS carries only the post-upgrade sender.
		c.write('MAIL FROM:<real@tls.test>\r\nRCPT TO:<b@b.test>\r\nDATA\r\n');
		await c.waitCode(354);
		c.write('body\r\n.\r\n');
		await c.waitFor((b) => /250 2\.0\.0/.test(b));
		expect(seen).toHaveLength(1);
		expect(seen[0]?.mailFrom?.address).toBe('real@tls.test');
		c.end();
	});

	it('observes a fully reset session object inside onData after the upgrade', async () => {
		const seen: Array<SessionSnapshot> = [];
		const { port } = await start({
			onData: (_message, session) => {
				seen.push(snapshot(session));
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
