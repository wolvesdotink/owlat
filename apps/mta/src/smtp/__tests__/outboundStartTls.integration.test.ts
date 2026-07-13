/**
 * Regression-lock for the outbound STARTTLS opportunistic-vs-enforce TLS contract
 * (audit PR-25 — RFC 7435 opportunistic, RFC 8461 MTA-STS, RFC 3207 STARTTLS,
 * RFC 6066 §3 SNI). These behaviours are only SOUND on top of PR-22's pool-key
 * fix (the TLS profile — requireTLS + rejectUnauthorized — is part of the pool
 * key) so a verifying/enforcing acquire is never served an earlier opportunistic
 * transport to a shared MX.
 *
 * Each test spins up a real loopback STARTTLS SMTPServer and drives a delivery
 * through the REAL {@link SmtpConnectionPool} + nodemailer (the same factory the
 * sender uses), so we observe the actual handshake — STARTTLS upgrade, DATA over
 * TLS, the SNI servername the server saw, and real certificate verification —
 * rather than a mock's say-so.
 *
 * The MTA-STS-policy plumbing (skip-MX-not-in-policy) and the multi-MX failover
 * loop are locked at the sender-loop level in sender.test.ts; here we lock the
 * transport-level TLS facts those loops depend on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { SmtpConnectionPool } from '../connectionPool.js';
import { classifyTlsFailure } from '../tlsFailureClassification.js';
import { resolveTlsRequirements } from '../tlsPolicy.js';
import { buildDanePeerVerifier, buildDanePolicyFingerprint } from '../daneVerify.js';
import { computeAssociation } from '@owlat/shared/dane';
import type { TlsaRecord } from '@owlat/shared/dane';
import { X509Certificate } from 'node:crypto';
// Throwaway self-signed cert/key (CN/SAN mx.test) shared with the other
// outbound-TLS integration tests.
import { MX_CERT, MX_KEY } from './certFixture.js';

interface ServerProbe {
	server: SMTPServer;
	port: number;
	/** The SNI servername the server's SNICallback observed, or null. */
	sniServername(): string | null;
	/** Whether the DATA command arrived on an upgraded (TLS) session. */
	dataOverTls(): boolean | null;
	/** Whether STARTTLS upgraded at least one inbound session. */
	upgraded(): boolean;
}

/**
 * Start a loopback STARTTLS SMTP server (secure:false ⇒ plaintext start, the
 * outbound port-25 path). The server starts in cleartext and the ONLY way a
 * session can become `secure` is for the client to issue STARTTLS (RFC 3207),
 * so `dataOverTls()` doubles as proof STARTTLS was attempted and succeeded.
 */
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
		// RFC 6066 §3: the client offers the target server name in the TLS
		// ClientHello. nodemailer derives it from `tls.servername` (or `host`).
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

describe('outbound STARTTLS opportunistic-vs-enforce (PR-25)', () => {
	let pool: SmtpConnectionPool | undefined;
	let probe: ServerProbe | undefined;

	afterEach(async () => {
		if (pool) await pool.closeAll(500);
		if (probe) await stopServer(probe.server);
		pool = undefined;
		probe = undefined;
	});

	// ── (1) Opportunistic TLS — RFC 7435 ──
	// A no-policy domain must still STARTTLS opportunistically but MUST NOT fail
	// delivery on an unverifiable certificate. With rejectUnauthorized:false the
	// self-signed / CN-mismatched MX cert is accepted and mail is delivered over
	// the encrypted channel.
	it('opportunistic: delivers to a self-signed MX over STARTTLS (rejectUnauthorized:false, no policy)', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		// No requireTLS / no servername set => mirrors the opportunistic no-policy
		// acquire (sender passes stsOptions.rejectUnauthorized=false here).
		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: true, // force the STARTTLS upgrade rather than fall to plaintext
			tls: { rejectUnauthorized: false },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		try {
			const info = await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'opportunistic',
				text: 'delivered over opportunistic TLS to a self-signed MX',
			});
			expect(info.accepted).toContain('recipient@example.test');
		} finally {
			pool.release(key);
		}

		// (3) STARTTLS attempted on the advertising MX, and DATA went over TLS.
		expect(probe.upgraded()).toBe(true);
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	// ── (2) Enforce — RFC 8461 §5 ──
	// Under an MTA-STS enforce policy the acquire verifies the certificate
	// (rejectUnauthorized:true). The self-signed MX cert is rejected: delivery
	// FAILS with a certificate-verification error that classifyTlsFailure maps
	// to a certificate-* TLS-RPT type (it must NOT be silently swallowed as a
	// bare socket error — RFC 8460 §4).
	it('enforce: a self-signed cert FAILS verification and classifies as certificate-not-trusted', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: true,
			// MTA-STS enforce => verifying. servername 'mx.test' matches the cert's
			// SAN, so the ONLY remaining failure is the untrusted (self-signed) CA.
			tls: { rejectUnauthorized: true, servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		let caught: { code?: string; message?: string; response?: string } | undefined;
		try {
			await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'enforce',
				text: 'must never be delivered to an unverifiable MX under enforce',
			});
			expect.fail('delivery should have failed certificate verification');
		} catch (err) {
			caught = err as { code?: string; message?: string };
		} finally {
			pool.release(key);
		}

		expect(caught).toBeDefined();
		// nodemailer wraps cert verification failures as code:'ESOCKET' whose
		// message carries the real reason ("self-signed certificate").
		expect(caught!.message ?? '').toMatch(/self-?signed/i);

		// The sender's classifier turns that into a certificate-* TLS-RPT type
		// (NOT null) so the failure is recorded, not dropped as a network blip.
		const classified = classifyTlsFailure(caught!);
		expect(classified).toBe('certificate-not-trusted');
		expect(classified).not.toBeNull();
	}, 15000);

	// ── (4) SNI — RFC 6066 §3 ──
	// When connecting to an MX named mx.test the client must offer that name in
	// the TLS ClientHello so the server can select the right certificate (shared
	// hosting / SAN selection). The server's SNICallback records the servername.
	it('SNI: the server SNICallback observes servername === "mx.test"', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: true,
			// Connect by loopback IP but offer the MX hostname as SNI, exactly as a
			// real send to host 'mx.test' would.
			tls: { rejectUnauthorized: false, servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		try {
			const info = await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'sni',
				text: 'sni servername should be mx.test',
			});
			expect(info.accepted).toContain('recipient@example.test');
		} finally {
			pool.release(key);
		}

		expect(probe.sniServername()).toBe('mx.test');
		// And DATA still rode the upgraded TLS session.
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('DANE-EE: a matching TLSA record authenticates the self-signed MX', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const certDer = new X509Certificate(MX_CERT).raw;
		const association = computeAssociation(certDer, 1, 1);
		expect(association).not.toBeNull();
		const records = [{ usage: 3, selector: 1, matchingType: 1, data: association! }];

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: true,
			tls: {
				...daneTlsOptions(records, ['mx.test']),
				servername: 'deliberately-wrong-name.example',
			},
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		try {
			const info = await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'dane-ee',
				text: 'authenticated solely by the DNSSEC TLSA leaf association',
			});
			expect(info.accepted).toContain('recipient@example.test');
		} finally {
			pool.release(key);
		}

		expect(probe.upgraded()).toBe(true);
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('DANE-EE: a TLSA mismatch aborts before SMTP DATA', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const records = [{ usage: 3, selector: 1, matchingType: 1, data: '00'.repeat(32) }];
		const verifyPeerCertificate = vi.fn(buildDanePeerVerifier(records, ['mx.test']));

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
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

		await expect(
			transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'dane-ee mismatch',
				text: 'must not reach DATA',
			})
		).rejects.toThrow(/DANE TLSA mismatch/);
		pool.release(key);

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

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: true,
			tls: {
				...daneTlsOptions(records, ['mx.test']),
				servername: 'mx.test',
			},
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		try {
			const info = await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'dane-ta',
				text: 'authenticated by the DNSSEC-associated trust anchor',
			});
			expect(info.accepted).toContain('recipient@example.test');
		} finally {
			pool.release(key);
		}
		expect(probe.dataOverTls()).toBe(true);
	}, 15000);

	it('DANE-TA: a trust-anchor match still rejects the wrong MX name before DATA', async () => {
		probe = await startServer();
		pool = new SmtpConnectionPool({ maxPerHost: 3, idleTimeoutMs: 30000, maxAgeMs: 300000 });
		const certDer = new X509Certificate(MX_CERT).raw;
		const association = computeAssociation(certDer, 0, 1);
		const records = [{ usage: 2, selector: 0, matchingType: 1, data: association! }];

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: true,
			tls: daneTlsOptions(records, ['wrong-mx.example']),
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		await expect(
			transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'dane-ta wrong name',
				text: 'must not reach DATA',
			})
		).rejects.toThrow(/DANE-TA validation failed: MX certificate name mismatch/);
		pool.release(key);
		expect(probe.dataOverTls()).toBeNull();
	}, 15000);

	// ── (3) ignoreTLS is never plumbed through the pool ──
	// The pool's transport factory must never disable STARTTLS. ignoreTLS:true
	// would let nodemailer skip the upgrade and send cleartext — a silent
	// STARTTLS-stripping bypass. AcquireOptions has no ignoreTLS field and the
	// factory never sets one; lock that the created transport carries no
	// ignoreTLS so DATA always rides TLS (asserted above) and never plaintext.
	it('ignoreTLS is never passed to the transport factory', async () => {
		// Inspect what the REAL factory builds by spying on nodemailer, then
		// asserting the options object has no ignoreTLS / disable-STARTTLS flag.
		const nodemailer = (await import('nodemailer')).default;
		const spy = vi.spyOn(nodemailer, 'createTransport');
		const inspectPool = new SmtpConnectionPool({
			maxPerHost: 3,
			idleTimeoutMs: 30000,
			maxAgeMs: 300000,
		});
		try {
			await inspectPool.acquire('mx.test', '127.0.0.1', {
				port: 25,
				secure: false,
				requireTLS: false,
				tls: { rejectUnauthorized: false },
			});
			const opts = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
			expect(opts).toBeDefined();
			expect('ignoreTLS' in opts!).toBe(false);
			expect(opts!['ignoreTLS']).toBeUndefined();
			// secure:false is STARTTLS-on-25, not "no TLS"; the factory must keep it.
			expect(opts!['secure']).toBe(false);
		} finally {
			spy.mockRestore();
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
 * records — certificate-not-trusted for a self-signed MX, starttls-not-supported
 * for a receiver that doesn't offer STARTTLS at all.
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
		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port: probe.port,
			secure: false,
			requireTLS: req.requireTLS,
			// servername 'mx.test' matches the cert SAN, so the ONLY failure is the
			// untrusted (self-signed) CA — exactly what require-verified must reject.
			tls: { rejectUnauthorized: req.rejectUnauthorized, servername: 'mx.test' },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		let caught: { code?: string; message?: string; response?: string } | undefined;
		try {
			await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'require-verified',
				text: 'must never be delivered to an unverifiable MX under require-verified',
			});
			expect.fail('delivery should have failed certificate verification');
		} catch (err) {
			caught = err as { code?: string; message?: string };
		} finally {
			pool.release(key);
		}

		expect(caught).toBeDefined();
		expect(classifyTlsFailure(caught!)).toBe('certificate-not-trusted');
	}, 15000);

	it('require (TLS mandatory) bounces on a receiver that offers no STARTTLS and records starttls-not-supported', async () => {
		// A plaintext-only server: STARTTLS is not advertised, so a requireTLS send
		// cannot upgrade and nodemailer fails the transaction rather than sending in
		// the clear.
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

		const { key, transport } = await pool.acquire('127.0.0.1', '127.0.0.1', {
			port,
			secure: false,
			requireTLS: req.requireTLS,
			tls: { rejectUnauthorized: req.rejectUnauthorized },
			connectionTimeout: 5000,
			greetingTimeout: 5000,
			socketTimeout: 5000,
		});

		let caught: { code?: string; message?: string; response?: string } | undefined;
		try {
			await transport.sendMail({
				from: 'sender@owlat.test',
				to: 'recipient@example.test',
				subject: 'require',
				text: 'must never be delivered in the clear when TLS is required',
			});
			expect.fail('delivery should have failed because STARTTLS is unavailable');
		} catch (err) {
			caught = err as { code?: string; message?: string };
		} finally {
			pool.release(key);
		}

		expect(caught).toBeDefined();
		expect(classifyTlsFailure(caught!)).toBe('starttls-not-supported');
	}, 15000);
});
