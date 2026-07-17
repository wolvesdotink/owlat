/**
 * Banner regression-lock for the single-IP EHLO/PTR posture (audit PR-64).
 *
 * RFC 5321 §4.2: the SMTP greeting is a `220 <domain> ...` line and the
 * `<domain>` SHOULD be the server's own fully-qualified hostname. For the
 * single-IP posture both inbound listeners (bounce + submission) must greet with
 * `config.ehloHostname` — the FQDN that matches the IP's reverse-DNS PTR record —
 * so a connecting MTA's banner/PTR consistency checks line up. A wrong or
 * os.hostname()-derived banner reads as a misconfigured relay.
 *
 * This drives each REAL server on a loopback ephemeral port and reads the actual
 * 220 greeting off the wire, asserting it starts with `220 mail.test.example `.
 * Both the bounce (port-25 MX) and the submission listeners now run on the
 * in-house `@owlat/smtp-listener`, normalized to a common {@link Greetable}
 * boot/close shape.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmtpListener } from '@owlat/smtp-listener';
import { createBounceServer } from '../../bounce/server.js';
import { createSubmissionServer, createImplicitTlsSubmissionServer } from '../submissionServer.js';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import type { Queue } from 'groupmq';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const EHLO = 'mail.test.example';
const redis = {} as never;
const queue = { add: vi.fn() } as unknown as Queue<EmailJob>;

/** A booted-and-closable server, abstracting smtp-server vs the in-house listener. */
interface Greetable {
	listen(): Promise<number>;
	close(): Promise<void>;
}

/** Adapt an `@owlat/smtp-listener` SmtpListener to {@link Greetable}. */
function fromListener(listener: SmtpListener): Greetable {
	return {
		listen: async () => {
			await listener.listen(0, '127.0.0.1');
			return (listener.address() as AddressInfo).port;
		},
		close: () => listener.close(),
	};
}

/**
 * Boot on a loopback ephemeral port and read the first SMTP greeting line.
 *
 * `tls: true` connects over an implicit-TLS socket — required for the 465
 * (implicit-TLS) submission listener, which wraps the whole connection in TLS
 * before emitting any banner. The bounce listener and the 587 STARTTLS
 * submission listener both greet in cleartext.
 */
async function readGreeting(server: Greetable, opts: { tls?: boolean } = {}): Promise<string> {
	const port = await server.listen();

	return new Promise<string>((resolve, reject) => {
		const socket: Socket = opts.tls
			? tlsConnect({ port, host: '127.0.0.1', rejectUnauthorized: false })
			: netConnect(port, '127.0.0.1');
		let buf = '';
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('timed out waiting for SMTP greeting'));
		}, 5000);
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buf += chunk;
			const nl = buf.indexOf('\r\n');
			if (nl !== -1) {
				clearTimeout(timer);
				const line = buf.slice(0, nl);
				socket.end();
				resolve(line);
			}
		});
		socket.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

describe('SMTP greeting banner uses config.ehloHostname (PR-64, RFC 5321 §4.2)', () => {
	let server: Greetable | undefined;

	// The submission listeners validate the PEM at construction, so those cases
	// need real TLS material. Generate a throwaway self-signed pair once.
	let certPem: string;
	let keyPem: string;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'owlat-banner-test-'));
		try {
			execFileSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'1',
				'-nodes',
				'-subj',
				`/CN=${EHLO}`,
			]);
			certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
			keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	afterEach(async () => {
		if (server) await server.close();
		server = undefined;
	});

	it('bounce server greets with "220 mail.test.example "', async () => {
		const config = {
			ehloHostname: EHLO,
			bounceMaxClients: 200,
			bounceMaxConnectionsPerIp: 10,
			bounceTarpitEnabled: false,
			bounceTarpitDelayMs: 0,
			inboundSpfEnabled: false,
			inboundDkimEnabled: false,
		} as unknown as MtaConfig;

		server = fromListener(createBounceServer(config, redis));
		const greeting = await readGreeting(server);

		expect(greeting.startsWith(`220 ${EHLO} `)).toBe(true);
	}, 15000);

	it('submission server (587 STARTTLS) greets with "220 mail.test.example "', async () => {
		const config = {
			apiKey: 'master-secret-key',
			ehloHostname: EHLO,
			submissionTlsCert: certPem,
			submissionTlsKey: keyPem,
			submissionMaxClients: 200,
			submissionMaxConnectionsPerIp: 10,
			submissionMaxAuthFailuresPerIp: 10,
		} as unknown as MtaConfig;

		server = fromListener(createSubmissionServer(queue, redis, config));
		// 587 opens in plaintext and advertises STARTTLS — the banner is cleartext.
		const greeting = await readGreeting(server);

		expect(greeting.startsWith(`220 ${EHLO} `)).toBe(true);
	}, 15000);

	it('implicit-TLS submission server (465) greets with "220 mail.test.example "', async () => {
		const config = {
			apiKey: 'master-secret-key',
			ehloHostname: EHLO,
			submissionTlsCert: certPem,
			submissionTlsKey: keyPem,
			submissionMaxClients: 200,
			submissionMaxConnectionsPerIp: 10,
			submissionMaxAuthFailuresPerIp: 10,
		} as unknown as MtaConfig;

		server = fromListener(createImplicitTlsSubmissionServer(queue, redis, config));
		// 465 wraps the connection in TLS from the first byte — greet over TLS.
		const greeting = await readGreeting(server, { tls: true });

		expect(greeting.startsWith(`220 ${EHLO} `)).toBe(true);
	}, 15000);
});
