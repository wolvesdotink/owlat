/**
 * Shared loopback-SMTP harness for the `sendToMx`-level integration suites.
 *
 * Both senderPlaintextTlsRpt.integration.test.ts (PR-24) and
 * senderOutboundTlsFloor.integration.test.ts (T1) drive the FULL {@link sendToMx}
 * through the REAL connection pool + real nodemailer + real tlsRpt against a
 * loopback {@link SMTPServer}. Only the destination port is rewritten (sendToMx
 * hardcodes 25). This module factors out the server factory, the job/config
 * builders and the microtask flush so each suite carries only its own assertions.
 *
 * NOTE: the `vi.mock` calls stay in each test file — Vitest hoists them per-module
 * and they cannot be shared from here.
 */
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { MX_CERT, MX_KEY } from './certFixture.js';
import type { EmailJob } from '../../types.js';
import type { MtaConfig } from '../../config.js';

export interface ServerProbe {
	server: SMTPServer;
	port: number;
	/** Whether the DATA command arrived at all (the body was accepted). */
	dataReached(): boolean;
	/**
	 * Whether the DATA command arrived on an upgraded (TLS) session, or `null`
	 * if the body never reached the server.
	 */
	dataOverTls(): boolean | null;
}

export interface StartServerOptions {
	/**
	 * Advertise STARTTLS in the EHLO response. When `false` the capability is both
	 * hidden AND the command is disabled, so an opportunistic client stays in
	 * cleartext and a `require` client that sends STARTTLS anyway gets a 5xx.
	 * The server is backed by the self-signed {@link MX_CERT}, so a client that
	 * DOES upgrade under verification (`require-verified`) fails the cert check.
	 * Defaults to `true`.
	 */
	advertiseStartTls?: boolean;
}

/**
 * Start a loopback SMTP server on an ephemeral loopback port. The server starts
 * in cleartext, so a session is only `secure` if the client issued STARTTLS
 * (RFC 3207).
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerProbe> {
	const advertiseStartTls = options.advertiseStartTls ?? true;
	let sawData = false;
	let dataSecure: boolean | null = null;

	const server = new SMTPServer({
		secure: false,
		authOptional: true,
		disabledCommands: advertiseStartTls ? ['AUTH'] : ['AUTH', 'STARTTLS'],
		hideSTARTTLS: !advertiseStartTls,
		cert: MX_CERT,
		key: MX_KEY,
		minVersion: 'TLSv1.2',
		onData(stream, session, cb) {
			sawData = true;
			dataSecure = session.secure === true;
			stream.on('data', () => {});
			stream.on('end', () => cb());
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
	return {
		server,
		port,
		dataReached: () => sawData,
		dataOverTls: () => dataSecure,
	};
}

export function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

export function createJob(overrides: Partial<EmailJob> = {}): EmailJob {
	return {
		messageId: 'msg-loopback-001',
		to: 'user@recipient.test',
		from: 'sender@owlat.com',
		subject: 'loopback',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
		...overrides,
	};
}

export function createConfig(overrides: Partial<MtaConfig> = {}): MtaConfig {
	return {
		port: 3100,
		bouncePort: 25,
		redisUrl: 'redis://localhost:6379',
		apiKey: 'test-key',
		ehloHostname: 'mail.owlat.com',
		ehloHostnames: {},
		returnPathDomain: 'bounces.owlat.com',
		convexSiteUrl: 'https://test.convex.site',
		webhookSecret: 'secret',
		ipPools: { transactional: ['127.0.0.1'], campaign: ['127.0.0.1'] },
		dkimKeys: {},
		workerConcurrency: 50,
		serverId: 'test-server',
		smtpPool: { maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 },
		orgLimits: { defaultDailyLimit: 50000, defaultHourlyLimit: 5000 },
		submissionPort: 587,
		submissionEnabled: false,
		contentScreeningEnabled: true,
		contentMaxSizeKb: 500,
		deliveryLogMaxLen: 100000,
		deliveryLogTtlHours: 72,
		webhookDlqMaxSize: 10000,
		bounceMaxConnectionsPerIp: 10,
		bounceMaxClients: 200,
		bounceTarpitEnabled: false,
		bounceTarpitDelayMs: 5000,
		inboundSpfEnabled: false,
		rspamdRejectThreshold: 15,
		smtpPoolGlobalMaxPerHost: 10,
		...overrides,
	} as MtaConfig;
}

export const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
