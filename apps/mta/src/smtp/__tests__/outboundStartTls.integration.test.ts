/**
 * Regression-lock for the outbound STARTTLS opportunistic-vs-enforce TLS contract
 * (audit PR-25 — RFC 7435 opportunistic, RFC 8461 MTA-STS, RFC 3207 STARTTLS,
 * RFC 6066 §3 SNI). These behaviours are only SOUND on top of PR-22's pool-key
 * fix (the TLS profile — requireTLS + rejectUnauthorized — is part of the pool
 * key) so a verifying/enforcing acquire is never served an earlier opportunistic
 * config to a shared MX.
 *
 * Each test spins up a real loopback STARTTLS SMTPServer and drives a delivery
 * through the REAL {@link SmtpConnectionPool} + @owlat/smtp-client (the same
 * engine the sender uses), so we observe the actual handshake — STARTTLS upgrade,
 * DATA over TLS, the SNI servername the server saw, real certificate verification,
 * and the structured {@link SmtpError} a failure carries — rather than a mock's
 * say-so.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import {
	SmtpConnection,
	sendEnvelope,
	isSmtpError,
	type SmtpConnectOptions,
} from '@owlat/smtp-client';
import { SmtpConnectionPool, type AcquireOptions } from '../connectionPool.js';
import { deliver, LOOPBACK_MESSAGE } from './loopbackMxHarness.js';
import { classifyTlsFailure } from '../tlsFailureClassification.js';
import { resolveTlsRequirements } from '../tlsPolicy.js';
import { buildDanePeerVerifier, buildDanePolicyFingerprint } from '../daneVerify.js';
import { computeAssociation } from '@owlat/shared/dane';
import type { TlsaRecord } from '@owlat/shared/dane';
import { X509Certificate } from 'node:crypto';
import { MX_CERT, MX_KEY } from './certFixture.js';

interface ServerProbe {
	server: SMTPServer;
	port: number;
	sniServername(): string | null;
	dataOverTls(): boolean | null;
	upgraded(): boolean;
}

async function startServer(): Promise<ServerProbe> {
	let sni: string | null = null;
	let dataSecure: boolean | null = null;
	let didUpgrade = false;

	const server = new SMTPServer({
		secure: false,
		authOptional: true,
		disabledCommands: ['AUTH'],
		cert: MX_CERT,
		key: MX_KEY,
		minVersion: 'TLSv1.2',
		SNICallback(servername, cb) {
			sni = servername;
			cb(null);
		},
		onSecure(_socket, _session, cb) {
			didUpgrade = true;
			cb();
		},
		onData(stream, session, cb) {
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
		sniServername: () => sni,
		dataOverTls: () => dataSecure,
		upgraded: () => didUpgrade,
	};
}

function stopServer(server: SMTPServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function daneTlsOptions(records: TlsaRecord[], referenceIdentifiers: string[]) {
	return {
		rejectUnauthorized: false,
		verifyPeerCertificate: buildDanePeerVerifier(records, referenceIdentifiers),
		danePolicyFingerprint: buildDanePolicyFingerprint(records, referenceIdentifiers),
	};
}

/** Drive a delivery expected to FAIL, returning the thrown error. */
async function attemptExpectFailure(
	pool: SmtpConnectionPool,
	options: AcquireOptions
): Promise<unknown> {
	const { key, config } = await pool.acquire('127.0.0.1', '127.0.0.1', options);
	let conn: SmtpConnection;
	try {
		conn = await SmtpConnection.connect(config);
	} catch (err) {
		pool.release(key);
		return err;
	}
	// Track success separately so the unexpected-success sentinel is thrown OUTSIDE
	// the try/catch — otherwise it would be caught by our own catch and returned as
	// the "caught" error, masking the bug — and so close()/release() run exactly
	// once on every path.
	let sendError: unknown;
	let delivered = false;
	try {
		await sendEnvelope(conn, {
			from: 'sender@owlat.test',
			to: ['recipient@example.test'],
			data: LOOPBACK_MESSAGE,
		});
		delivered = true;
	} catch (err) {
		sendError = err;
	} finally {
		conn.close();
		pool.release(key);
	}
	if (delivered) {
		throw new Error('expected a TLS failure but delivery succeeded');
	}
	return sendError;
}

describe('outbound STARTTLS opportunistic-vs-enforce (PR-25)', () => {
	let pool: SmtpConnectionPool | undefined;
	let probe: ServerProbe | undefined;

	afterEach(async () => {
		if (pool) await pool.closeAll(500);
		if (probe) await stopServer(probe.server);
		pool = undefined;
		probe = undefined;
	});

	it('opportunistic: delivers to a self-signed MX over STARTTLS (rejectUnauthorized:false, no policy)', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const result = await deliver(pool, {
			port: probe.port,
			requireTLS: true, // force the STARTTLS upgrade rather than fall to plaintext
			tls: { rejectUnauthorized: false },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});
		expect(result.accepted.map((v) => v.recipient)).toContain('recipient@example.test');

		expect(probe.upgraded()).toBe(true);
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('enforce: a self-signed cert FAILS verification and classifies as certificate-not-trusted', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const caught = await attemptExpectFailure(pool, {
			port: probe.port,
			requireTLS: true,
			// servername 'mx.test' matches the cert SAN, so the ONLY remaining failure
			// is the untrusted (self-signed) CA.
			tls: { rejectUnauthorized: true, servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		expect(isSmtpError(caught)).toBe(true);
		if (!isSmtpError(caught)) throw caught;
		expect(caught.tlsCause).toBe('cert-untrusted');
		// The sender's classifier turns that into a certificate-* TLS-RPT type.
		expect(classifyTlsFailure(caught.tlsCause!)).toBe('certificate-not-trusted');
		// DATA never rode an unverified session.
		expect(probe.dataOverTls()).toBeNull();
	}, 15000);

	it('SNI: the server SNICallback observes servername === "mx.test"', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const result = await deliver(pool, {
			port: probe.port,
			requireTLS: true,
			tls: { rejectUnauthorized: false, servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});
		expect(result.accepted.map((v) => v.recipient)).toContain('recipient@example.test');

		expect(probe.sniServername()).toBe('mx.test');
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('DANE-EE: a matching TLSA record authenticates the self-signed MX', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const certDer = new X509Certificate(MX_CERT).raw;
		const association = computeAssociation(certDer, 1, 1);
		expect(association).not.toBeNull();
		const records = [{ usage: 3, selector: 1, matchingType: 1, data: association! }];

		const result = await deliver(pool, {
			port: probe.port,
			requireTLS: true,
			tls: {
				...daneTlsOptions(records, ['mx.test']),
				servername: 'deliberately-wrong-name.example',
			},
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});
		expect(result.accepted.map((v) => v.recipient)).toContain('recipient@example.test');

		expect(probe.upgraded()).toBe(true);
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('DANE-EE: a TLSA mismatch aborts before SMTP DATA', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const records = [{ usage: 3, selector: 1, matchingType: 1, data: '00'.repeat(32) }];
		const verifyPeerCertificate = vi.fn(buildDanePeerVerifier(records, ['mx.test']));

		const caught = await attemptExpectFailure(pool, {
			port: probe.port,
			requireTLS: true,
			tls: {
				rejectUnauthorized: false,
				verifyPeerCertificate,
				danePolicyFingerprint: buildDanePolicyFingerprint(records, ['mx.test']),
			},
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		expect(isSmtpError(caught)).toBe(true);
		expect((caught as Error).message).toMatch(/DANE TLSA mismatch/);
		expect(verifyPeerCertificate).toHaveBeenCalledOnce();
		expect(probe.dataOverTls()).toBeNull();
	}, 15000);

	it('DANE-TA: an associated CA certificate authenticates the named MX', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const certDer = new X509Certificate(MX_CERT).raw;
		const association = computeAssociation(certDer, 0, 1);
		expect(association).not.toBeNull();
		const records = [{ usage: 2, selector: 0, matchingType: 1, data: association! }];

		const result = await deliver(pool, {
			port: probe.port,
			requireTLS: true,
			tls: { ...daneTlsOptions(records, ['mx.test']), servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});
		expect(result.accepted.map((v) => v.recipient)).toContain('recipient@example.test');
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('DANE-TA: a trust-anchor match still rejects the wrong MX name before DATA', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const certDer = new X509Certificate(MX_CERT).raw;
		const association = computeAssociation(certDer, 0, 1);
		const records = [{ usage: 2, selector: 0, matchingType: 1, data: association! }];

		const caught = await attemptExpectFailure(pool, {
			port: probe.port,
			requireTLS: true,
			tls: daneTlsOptions(records, ['wrong-mx.example']),
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});
		expect((caught as Error).message).toMatch(
			/DANE-TA validation failed: MX certificate name mismatch/
		);
		expect(probe.dataOverTls()).toBeNull();
	}, 15000);

	// The pool's connect config must always attempt STARTTLS and never disable it.
	// tlsMode 'starttls' is the only outbound MX shape; there is no field that
	// could let the client skip the upgrade and send cleartext.
	it('the pooled connect config always uses tlsMode starttls (never disables TLS)', async () => {
		const inspectPool = new SmtpConnectionPool({
			maxPerHost: 3,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
		});
		try {
			const { config } = await inspectPool.acquire('mx.test', '127.0.0.1', {
				port: 25,
				requireTLS: false,
				tls: { rejectUnauthorized: false },
			});
			const asRecord = config as unknown as Record<string, unknown> & SmtpConnectOptions;
			expect(config.tlsMode).toBe('starttls');
			expect('ignoreTLS' in asRecord).toBe(false);
			expect(config.requireTls).toBe(false);
		} finally {
			await inspectPool.closeAll(100);
		}
	});
});

/**
 * T1 — OUTBOUND_TLS_MODE=require-verified against a broken-TLS receiver.
 *
 * The resolver ({@link resolveTlsRequirements}) turns require-verified (with no
 * MTA-STS policy) into requireTLS + rejectUnauthorized, and the sender feeds
 * exactly those into the pool acquire. We drive the REAL pool with that profile
 * and prove the handshake FAILS (delivery would bounce, never falling back to
 * cleartext) and that the failure classifies to the TLS-RPT type the sender
 * records.
 */
describe('outbound require-verified vs broken TLS (T1)', () => {
	let pool: SmtpConnectionPool | undefined;
	let probe: ServerProbe | undefined;
	let plainServer: SMTPServer | undefined;

	afterEach(async () => {
		if (pool) await pool.closeAll(500);
		if (probe) await stopServer(probe.server);
		if (plainServer) await stopServer(plainServer);
		pool = undefined;
		probe = undefined;
		plainServer = undefined;
	});

	it('resolver: require-verified + no policy → requireTLS && verify', () => {
		const req = resolveTlsRequirements({
			localMode: 'require-verified',
			stsPolicy: { policyMode: 'none' },
			daneResult: null,
		});
		expect(req.requireTLS).toBe(true);
		expect(req.rejectUnauthorized).toBe(true);
	});

	it('require-verified bounces on a self-signed MX and records certificate-not-trusted', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const req = resolveTlsRequirements({
			localMode: 'require-verified',
			stsPolicy: { policyMode: 'none' },
			daneResult: null,
		});
		const caught = await attemptExpectFailure(pool, {
			port: probe.port,
			requireTLS: req.requireTLS,
			tls: { rejectUnauthorized: req.rejectUnauthorized, servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		expect(isSmtpError(caught)).toBe(true);
		if (!isSmtpError(caught)) throw caught;
		expect(classifyTlsFailure(caught.tlsCause!)).toBe('certificate-not-trusted');
	}, 15000);

	it('require (TLS mandatory) bounces on a receiver that offers no STARTTLS and records starttls-not-supported', async () => {
		plainServer = new SMTPServer({
			secure: false,
			authOptional: true,
			disabledCommands: ['AUTH', 'STARTTLS'],
			onData(stream, _session, cb) {
				stream.on('data', () => {});
				stream.on('end', () => cb());
			},
		});
		plainServer.on('error', () => {});
		await new Promise<void>((resolve, reject) => {
			plainServer!.once('error', reject);
			plainServer!.listen(0, '127.0.0.1', () => {
				plainServer!.removeListener('error', reject);
				resolve();
			});
		});
		const port = (plainServer.server.address() as AddressInfo).port;

		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const req = resolveTlsRequirements({
			localMode: 'require',
			stsPolicy: { policyMode: 'none' },
			daneResult: null,
		});
		expect(req.requireTLS).toBe(true);

		const caught = await attemptExpectFailure(pool, {
			port,
			requireTLS: req.requireTLS,
			tls: { rejectUnauthorized: req.rejectUnauthorized },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		expect(isSmtpError(caught)).toBe(true);
		if (!isSmtpError(caught)) throw caught;
		expect(caught.tlsCause).toBe('starttls-unavailable');
		expect(classifyTlsFailure(caught.tlsCause)).toBe('starttls-not-supported');
	}, 15000);
});
