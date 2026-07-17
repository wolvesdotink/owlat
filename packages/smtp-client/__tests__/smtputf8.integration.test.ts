/**
 * SMTPUTF8 / EAI (RFC 6531) — the client half of piece X3.
 *
 * Named test gate (b): when the envelope carries a non-ASCII (internationalized)
 * mailbox, {@link sendEnvelope} must
 *   - request `SMTPUTF8` on MAIL FROM iff the server advertised it, and
 *   - FAIL CLOSED when it did NOT — before a single byte reaches the wire —
 *     with a phase-`mail` {@link SmtpError} carrying the distinct discriminant
 *     `clientRefusal: 'smtputf8-unavailable'` (a permanent, non-retryable
 *     condition: there is no ASCII downgrade for a UTF-8 local-part).
 *
 * An all-ASCII envelope must be byte-identical to the pre-X3 path — no SMTPUTF8
 * keyword ever appears, whether or not the server advertised the extension.
 *
 * These drive the client against a raw `net` peer whose EHLO and reply framing we
 * control exactly, recording every received chunk so a test can prove precisely
 * which bytes reached (or never reached) the wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { sendEnvelope, envelopeRequiresSmtpUtf8 } from '../src/transaction';
import { isSmtpError } from '../src/errors';

const MESSAGE = ['From: sender@example.com', 'To: rcpt@example.net', '', 'body'].join('\r\n');

interface PeerOptions {
	/** EHLO response — advertise SMTPUTF8 here to enable the client's tagging path. */
	ehloReply: string;
}

interface RunningPeer {
	port: number;
	/** Every raw chunk the peer received — proves which commands reached the wire. */
	chunks: Buffer[];
}

const closers: Array<() => void> = [];

function startPeer(options: PeerOptions): Promise<RunningPeer> {
	const chunks: Buffer[] = [];
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		socket.write('220 utf8 ready\r\n');
		let buffer = '';
		let inData = false;
		socket.on('data', (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk));
			buffer += chunk.toString('utf8');
			if (inData) {
				if (buffer.includes('\r\n.\r\n')) {
					inData = false;
					buffer = '';
					socket.write('250 2.0.0 queued\r\n');
				}
				return;
			}
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				if (/^EHLO/i.test(line)) {
					socket.write(options.ehloReply);
				} else if (/^MAIL FROM/i.test(line)) {
					socket.write('250 2.1.0 sender ok\r\n');
				} else if (/^RCPT TO/i.test(line)) {
					socket.write('250 2.1.5 rcpt ok\r\n');
				} else if (/^DATA/i.test(line)) {
					socket.write('354 end with <CRLF>.<CRLF>\r\n');
					inData = true;
					break;
				} else if (/^QUIT/i.test(line)) {
					socket.write('221 2.0.0 bye\r\n');
				} else {
					socket.write('250 2.0.0 ok\r\n');
				}
				nl = buffer.indexOf('\n');
			}
		});
	});
	server.on('error', () => {});
	closers.push(() => server.close());
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () =>
			resolve({ port: (server.address() as AddressInfo).port, chunks })
		);
	});
}

function connectPlain(port: number): Promise<SmtpConnection> {
	return SmtpConnection.connect({
		host: '127.0.0.1',
		port,
		ehloName: 'client.test',
		tlsMode: 'none',
	});
}

/** The concatenated bytes the peer received, as a UTF-8 string. */
function received(chunks: readonly Buffer[]): string {
	return Buffer.concat(chunks).toString('utf8');
}

const SMTPUTF8_EHLO = '250-utf8 greets you\r\n250-SIZE 10485760\r\n250 SMTPUTF8\r\n';
const NO_SMTPUTF8_EHLO = '250-utf8 greets you\r\n250 SIZE 10485760\r\n';

afterEach(() => {
	while (closers.length > 0) {
		try {
			closers.pop()?.();
		} catch {
			// best-effort teardown
		}
	}
});

describe('envelopeRequiresSmtpUtf8 — structural detection', () => {
	it('flags a non-ASCII local-part in the return path or a recipient', () => {
		expect(
			envelopeRequiresSmtpUtf8({ from: '用户@example.com', to: ['a@example.net'], data: '' })
		).toBe(true);
		expect(
			envelopeRequiresSmtpUtf8({ from: 'a@example.com', to: ['收件@example.net'], data: '' })
		).toBe(true);
	});

	it('flags a non-ASCII (U-label) domain', () => {
		expect(envelopeRequiresSmtpUtf8({ from: 'a@例え.test', to: ['b@example.net'], data: '' })).toBe(
			true
		);
	});

	it('leaves a fully ASCII envelope alone', () => {
		expect(
			envelopeRequiresSmtpUtf8({
				from: 'sender@example.com',
				to: ['a@example.net', 'b@example.net'],
				data: '',
			})
		).toBe(false);
	});
});

describe('SMTPUTF8 tagging when advertised', () => {
	it('appends SMTPUTF8 to MAIL FROM for an internationalized envelope and delivers', async () => {
		const peer = await startPeer({ ehloReply: SMTPUTF8_EHLO });
		const conn = await connectPlain(peer.port);
		expect(conn.capabilities.smtpUtf8).toBe(true);

		const result = await sendEnvelope(conn, {
			from: '发件人@example.com',
			to: ['用户@example.net'],
			data: MESSAGE,
		});
		conn.close();

		expect(result.response.code).toBe(250);
		const wire = received(peer.chunks);
		const mailLine = /MAIL FROM:[^\r\n]*/.exec(wire)?.[0] ?? '';
		expect(mailLine).toContain('SMTPUTF8');
		// SIZE (advertised) precedes the SMTPUTF8 keyword; both ride MAIL FROM only.
		expect(mailLine).toContain('SIZE=');
		expect(/RCPT TO:[^\r\n]*SMTPUTF8/i.test(wire)).toBe(false);
	});

	it('does NOT tag an all-ASCII envelope even when SMTPUTF8 is advertised', async () => {
		const peer = await startPeer({ ehloReply: SMTPUTF8_EHLO });
		const conn = await connectPlain(peer.port);
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['rcpt@example.net'],
			data: MESSAGE,
		});
		conn.close();
		expect(result.response.code).toBe(250);
		expect(received(peer.chunks)).not.toContain('SMTPUTF8');
	});
});

describe('fail-closed when SMTPUTF8 is NOT advertised', () => {
	it('refuses an internationalized envelope at phase `mail` before any byte reaches the wire', async () => {
		const peer = await startPeer({ ehloReply: NO_SMTPUTF8_EHLO });
		const conn = await connectPlain(peer.port);
		expect(conn.capabilities.smtpUtf8).toBe(false);

		let caught: unknown;
		try {
			await sendEnvelope(conn, {
				from: '用户@example.com',
				to: ['收件@example.net'],
				data: MESSAGE,
			});
		} catch (err) {
			caught = err;
		}
		conn.close();

		expect(isSmtpError(caught)).toBe(true);
		if (isSmtpError(caught)) {
			expect(caught.phase).toBe('mail');
			expect(caught.clientRefusal).toBe('smtputf8-unavailable');
			// A client-side refusal carries no server reply code.
			expect(caught.replyCode).toBeUndefined();
			expect(caught.tlsCause).toBeUndefined();
		}
		// Fail-closed: MAIL FROM never reached the wire (only EHLO did).
		expect(received(peer.chunks)).not.toContain('MAIL FROM');
	});

	it('still delivers an all-ASCII envelope against a non-SMTPUTF8 server (no regression)', async () => {
		const peer = await startPeer({ ehloReply: NO_SMTPUTF8_EHLO });
		const conn = await connectPlain(peer.port);
		const result = await sendEnvelope(conn, {
			from: 'sender@example.com',
			to: ['rcpt@example.net'],
			data: MESSAGE,
		});
		conn.close();
		expect(result.response.code).toBe(250);
		expect(received(peer.chunks)).not.toContain('SMTPUTF8');
	});
});
