/**
 * Integration tests for the RSET reuse boundary ({@link resetTransaction}) — the
 * X1 primitive that lets the MTA pool carry a SECOND MAIL/RCPT/DATA transaction
 * over the SAME live socket without leaking state from the first (the classic
 * reuse bug class: a leftover reply or a half-read multiline response desyncing
 * the next command).
 *
 * Three cases:
 *   (a) two full sends over ONE connection, separated by RSET, both delivered
 *       byte-correctly — and the reader is clean between them (the second MAIL
 *       reads its OWN 250, never a stale reply);
 *   (b) a server that rejects RSET (5xx) surfaces a phase-`mail` SmtpError so the
 *       caller discards the socket;
 *   (c) RSET over a socket the peer already closed rejects (poisoned — never
 *       reused).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { SMTPServerOptions } from 'smtp-server';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { SmtpConnection } from '../src/connection';
import { sendEnvelope, resetTransaction } from '../src/transaction';
import { isSmtpError } from '../src/errors';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
});

interface CapturedMessage {
	from: string;
	to: string[];
	body: string;
}

async function startServer(
	options: SMTPServerOptions,
	messages: CapturedMessage[]
): Promise<number> {
	const server = new SMTPServer({
		secure: false,
		authOptional: true,
		disabledCommands: ['AUTH', 'STARTTLS'],
		onData(stream, session, cb) {
			let body = '';
			stream.on('data', (chunk) => {
				body += chunk.toString('utf8');
			});
			stream.on('end', () => {
				messages.push({
					from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
					to: session.envelope.rcptTo.map((r) => r.address),
					body,
				});
				cb();
			});
		},
		...options,
	});
	server.on('error', () => {});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.server.address() as AddressInfo).port;
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return port;
}

/** A raw cleartext SMTP peer whose per-line replies are scripted by `handle`. */
async function startRawServer(
	handle: (line: string, socket: net.Socket) => string | null
): Promise<number> {
	const server = net.createServer((socket) => {
		socket.on('error', () => {});
		socket.write('220 raw.test ESMTP\r\n');
		let buffer = '';
		let inData = false;
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			if (inData) {
				const dotIdx = buffer.indexOf('\r\n.\r\n');
				if (dotIdx !== -1) {
					inData = false;
					buffer = buffer.slice(dotIdx + 5);
					socket.write('250 2.0.0 queued\r\n');
				}
				return;
			}
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				if (/^DATA$/i.test(line)) {
					inData = true;
					socket.write('354 go ahead\r\n');
				} else {
					const reply = handle(line, socket);
					if (reply !== null) {
						socket.write(reply);
					}
				}
				nl = buffer.indexOf('\n');
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return port;
}

async function connect(port: number): Promise<SmtpConnection> {
	const conn = await SmtpConnection.connect({
		host: '127.0.0.1',
		port,
		tlsMode: 'none',
		ehloName: 'client.test',
	});
	cleanups.push(() => conn.close());
	return conn;
}

describe('resetTransaction — RSET reuse boundary (X1)', () => {
	it('carries two full transactions over ONE socket, delivering both byte-correctly', async () => {
		const messages: CapturedMessage[] = [];
		let connections = 0;
		const port = await startServer(
			{ onConnect: (_session, cb) => ((connections += 1), cb()) },
			messages
		);

		const conn = await connect(port);

		const first = await sendEnvelope(conn, {
			from: 'a@sender.test',
			to: ['one@rcpt.test'],
			data: 'Subject: first\r\n\r\nbody one\r\n',
		});
		expect(first.response.code).toBe(250);

		// The reuse boundary: a verified 250 returns the socket to a clean pre-MAIL
		// state with no buffered reply left over from the first transaction.
		await resetTransaction(conn);

		const second = await sendEnvelope(conn, {
			from: 'b@sender.test',
			to: ['two@rcpt.test'],
			data: 'Subject: second\r\n\r\nbody two\r\n',
		});
		// The second MAIL/RCPT/DATA read their OWN replies: a leaked stale reply would
		// have desynced this and produced the wrong code (or a hang).
		expect(second.response.code).toBe(250);

		expect(connections).toBe(1); // ONE socket carried both
		expect(messages).toHaveLength(2);
		expect(messages[0]!.to).toEqual(['one@rcpt.test']);
		expect(messages[0]!.body).toContain('body one');
		expect(messages[1]!.from).toBe('b@sender.test');
		expect(messages[1]!.to).toEqual(['two@rcpt.test']);
		expect(messages[1]!.body).toContain('body two');
	});

	it('does not leak the first transaction envelope into the second', async () => {
		const messages: CapturedMessage[] = [];
		const port = await startServer({}, messages);
		const conn = await connect(port);

		await sendEnvelope(conn, {
			from: 'a@sender.test',
			to: ['x@rcpt.test', 'y@rcpt.test'],
			data: 'Subject: m1\r\n\r\none\r\n',
		});
		await resetTransaction(conn);
		await sendEnvelope(conn, {
			from: 'b@sender.test',
			to: ['z@rcpt.test'],
			data: 'Subject: m2\r\n\r\ntwo\r\n',
		});

		// RSET cleared the aborted transaction: the second message has ONLY its own
		// single recipient, none of the first transaction's two.
		expect(messages[1]!.to).toEqual(['z@rcpt.test']);
		expect(messages[1]!.from).toBe('b@sender.test');
	});

	it('throws a phase-`mail` SmtpError when the server rejects RSET (caller must discard)', async () => {
		let sawData = false;
		const port = await startRawServer((line) => {
			if (/^EHLO/i.test(line)) return '250-raw.test\r\n250 SIZE 0\r\n';
			if (/^MAIL FROM/i.test(line)) return '250 2.1.0 ok\r\n';
			if (/^RCPT TO/i.test(line)) return '250 2.1.5 ok\r\n';
			if (/^RSET$/i.test(line)) return '500 5.5.1 command unrecognized\r\n';
			return '250 ok\r\n';
		});
		const conn = await connect(port);
		const first = await sendEnvelope(conn, {
			from: 'a@sender.test',
			to: ['one@rcpt.test'],
			data: 'Subject: m\r\n\r\nb\r\n',
		});
		expect(first.response.code).toBe(250);
		void sawData;

		const err = await resetTransaction(conn).then(
			() => null,
			(e: unknown) => e
		);
		expect(isSmtpError(err)).toBe(true);
		if (isSmtpError(err)) {
			expect(err.phase).toBe('mail');
			expect(err.replyCode).toBe(500);
		}
	});

	it('refuses to reuse a socket that has buffered/unsolicited data (leak guard)', async () => {
		// A peer that appends an UNSOLICITED line after the final 250 leaves a reply
		// buffered on the reader; reusing the socket would consume it as the RSET's
		// answer and desync every later read. resetTransaction refuses BEFORE sending
		// RSET.
		const server = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.write('220 chatty.test ESMTP\r\n');
			let buffer = '';
			let inData = false;
			socket.on('data', (chunk) => {
				buffer += chunk.toString('utf8');
				if (inData) {
					const dotIdx = buffer.indexOf('\r\n.\r\n');
					if (dotIdx !== -1) {
						inData = false;
						buffer = buffer.slice(dotIdx + 5);
						// Final reply + an unsolicited extra line in the SAME write.
						socket.write('250 2.0.0 queued\r\n250 2.0.0 surprise\r\n');
					}
					return;
				}
				let nl = buffer.indexOf('\n');
				while (nl !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, '');
					buffer = buffer.slice(nl + 1);
					if (/^EHLO/i.test(line)) socket.write('250 chatty.test\r\n');
					else if (/^DATA$/i.test(line)) {
						inData = true;
						socket.write('354 go ahead\r\n');
					} else socket.write('250 ok\r\n');
					nl = buffer.indexOf('\n');
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as AddressInfo).port;
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const conn = await connect(port);
		await sendEnvelope(conn, {
			from: 'a@sender.test',
			to: ['one@rcpt.test'],
			data: 'Subject: m\r\n\r\nb\r\n',
		});
		// Let the unsolicited line arrive and buffer on the reader.
		await new Promise((resolve) => setTimeout(resolve, 30));

		const err = await resetTransaction(conn).then(
			() => null,
			(e: unknown) => e
		);
		expect(isSmtpError(err)).toBe(true);
		if (isSmtpError(err)) {
			expect(err.phase).toBe('mail');
			expect(err.message).toContain('buffered data');
		}
	});

	it('rejects when RSET runs over a socket the peer already closed (poisoned)', async () => {
		const messages: CapturedMessage[] = [];
		const port = await startServer({}, messages);
		const conn = await connect(port);
		await sendEnvelope(conn, {
			from: 'a@sender.test',
			to: ['one@rcpt.test'],
			data: 'Subject: m\r\n\r\nb\r\n',
		});
		// Destroy the underlying socket out from under the connection, then RSET.
		conn.rawSocket.destroy();
		await new Promise((resolve) => setImmediate(resolve));

		await expect(resetTransaction(conn)).rejects.toBeInstanceOf(Error);
	});
});
