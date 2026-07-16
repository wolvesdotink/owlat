/**
 * Integration regression-lock for the single-IP EHLO/PTR posture (audit PR-64).
 *
 * The correct single-IP deliverability posture (RFC 5321 §4.1.1.1, the 2024
 * Gmail/Yahoo bulk-sender rules) is: every outbound connection announces an EHLO
 * name that is a real FQDN matching the bind IP's reverse-DNS PTR record — and
 * NEVER `os.hostname()` (the container/host name, which has no PTR).
 *
 * `sendToMx` computes that name via `resolveEhloForIp(config, bindIp)` and threads
 * it to `pool.acquire(..., { name })`. The pool sets it as the connect config's
 * `ehloName`, which @owlat/smtp-client announces in the SMTP `EHLO`/`HELO`
 * command. The receiving MTA records it as `session.hostNameAppearsAs`.
 *
 * This test drives the REAL {@link SmtpConnectionPool} + @owlat/smtp-client against
 * a real loopback smtp-server and asserts the server saw exactly `config.ehloHostname`
 * (`mail.test.example`) — proving the `name → hostNameAppearsAs` contract that
 * `sendToMx` depends on, and that no `os.hostname()` value leaks onto the wire.
 * The unit test in `sender.test.ts` ("per-IP EHLO hostname" + the single-IP case)
 * locks the other half: that `sendToMx` actually passes `config.ehloHostname` as
 * `name` for an unmapped/single bind IP.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { SmtpConnection, sendEnvelope, quit } from '@owlat/smtp-client';
import { SmtpConnectionPool } from '../connectionPool.js';
import { resolveEhloForIp } from '../../config.js';

const MESSAGE = Buffer.from(
	'From: sender@mail.test.example\r\nTo: recipient@example.test\r\nSubject: t\r\n\r\nbody\r\n'
);

/** Capture the EHLO name the client announced, per accepted message. */
async function startRecordingServer(): Promise<{
	server: SMTPServer;
	port: number;
	seen: string[];
}> {
	const seen: string[] = [];
	const server = new SMTPServer({
		secure: false,
		authOptional: true,
		disabledCommands: ['AUTH', 'STARTTLS'], // plaintext loopback — no TLS needed
		onData(stream, session, callback) {
			// `hostNameAppearsAs` is the verbatim EHLO/HELO argument the client sent.
			seen.push(String(session.hostNameAppearsAs ?? ''));
			stream.on('data', () => {});
			stream.on('end', () => callback());
		},
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
	return { server, port, seen };
}

function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('outbound EHLO name end-to-end (PR-64)', () => {
	let pool: SmtpConnectionPool | undefined;
	let server: SMTPServer | undefined;

	afterEach(async () => {
		if (pool) await pool.closeAll(500);
		if (server) await stopServer(server);
		pool = undefined;
		server = undefined;
	});

	it('announces config.ehloHostname as the EHLO name the receiver records (never os.hostname())', async () => {
		const started = await startRecordingServer();
		server = started.server;

		// Single-IP posture: no per-IP override, so resolveEhloForIp returns the
		// global config.ehloHostname — exactly what sendToMx passes to pool.acquire.
		const ehloHostname = resolveEhloForIp(
			{ ehloHostname: 'mail.test.example', ehloHostnames: {} },
			'127.0.0.1'
		);
		expect(ehloHostname).toBe('mail.test.example');

		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const { key, config } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: started.port,
			tls: { rejectUnauthorized: false },
			name: ehloHostname, // <- the value sendToMx threads through
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		const conn = await SmtpConnection.connect(config);
		try {
			const result = await sendEnvelope(conn, {
				from: 'sender@mail.test.example',
				to: ['recipient@example.test'],
				data: MESSAGE,
			});
			expect(result.accepted.map((v) => v.recipient)).toContain('recipient@example.test');
		} finally {
			await quit(conn);
			pool.release(key);
		}

		// The receiver recorded the configured FQDN verbatim…
		expect(started.seen).toContain('mail.test.example');
		// …and NEVER the OS/container hostname (which has no matching PTR record).
		expect(started.seen).not.toContain(os.hostname());
	}, 15000);
});
