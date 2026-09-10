/**
 * DANE at send time (RFC 7672) across DANE_MODE off / report / enforce: which
 * attempts carry the TLSA certificate hook, when the MX loop defers rather than
 * downgrading, and what each outcome records in TLS-RPT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';

// Every sendToMx suite stubs the same seams — transport, pool, MX/DANE/STS
// discovery, DKIM keys, logger — so the mock set is built once in
// helpers/senderHarness.ts and registered here.
const harness = await vi.hoisted(async () => {
	const { createSenderHarness } = await import('./helpers/senderHarness.js');
	return createSenderHarness();
});

vi.mock('../../scaling/ipPool.js', () => harness.ipPoolModule());
vi.mock('@owlat/smtp-client', async (importOriginal) =>
	harness.smtpClientModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../connectionPool.js', () => harness.connectionPoolModule());
vi.mock('../mxResolver.js', () => harness.mxResolverModule());
vi.mock('../daneMxResolver.js', () => harness.daneMxResolverModule());
vi.mock('../mtaSts.js', async (importOriginal) =>
	harness.mtaStsModule(await importOriginal<Record<string, unknown>>())
);
vi.mock('../dkim.js', () => harness.dkimModule());
vi.mock('../daneResolver.js', () => harness.daneResolverModule());
vi.mock('../../bounce/verp.js', () => harness.verpModule());
vi.mock('../../queue/groups.js', () => harness.queueGroupsModule());
vi.mock('../../monitoring/logger.js', () => harness.loggerModule());

const {
	connectMock,
	sendEnvelopeMock,
	acquireMock,
	releaseMock,
	evictConnectionMock,
	leaseValidMock,
} = harness;

import { sendToMx } from '../sender.js';
import type { MtaConfig } from '../../config.js';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { resolveDaneMxDestinations } from '../daneMxResolver.js';
import { lookupTlsaRecords } from '../daneResolver.js';
import { MX_CERT } from './certFixture.js';
import {
	acquireCallOptions,
	createConfig,
	createJob,
	installSenderDefaults,
	liveConn,
	smtpError,
	tlsRptReportFor,
} from './helpers/senderFixtures.js';

describe('sendToMx DANE', () => {
	let redis: InstanceType<typeof Redis>;
	let config: MtaConfig;

	beforeEach(async () => {
		vi.clearAllMocks();
		redis = new Redis();
		await redis.flushall();
		config = createConfig();
		installSenderDefaults(harness);
	});

	const acquireOpts = (call = 0) => acquireCallOptions(acquireMock, call);
	const reportFor = () => tlsRptReportFor(redis);

	describe('DANE at send time (T3)', () => {
		const CERT_SPKI_SHA256 = '49fc4a5424807bbbde5617d8b4bb563a79f4566c28d4d9b2e917dddcc7bac89c';
		const MATCHING_TLSA = { usage: 3, selector: 1, matchingType: 1, data: CERT_SPKI_SHA256 };
		const MISMATCH_TLSA = { usage: 3, selector: 1, matchingType: 1, data: 'deadbeef'.repeat(8) };

		function fixturePeerCert(): PeerCertificate {
			return { raw: new X509Certificate(MX_CERT).raw } as unknown as PeerCertificate;
		}
		function fixtureTlsSocket(): TLSSocket {
			return { getPeerCertificate: () => fixturePeerCert() } as unknown as TLSSocket;
		}
		function daneConfig(mode: 'report' | 'enforce' = 'enforce'): MtaConfig {
			return createConfig({ daneMode: mode, daneResolverUrl: 'https://doh.example/dns-query' });
		}

		it('mode OFF => resolver never consulted; acquire has no DANE hook (byte-identical to T1)', async () => {
			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			const tlsOpts = acquireOpts(0).tls ?? {};
			expect(tlsOpts).not.toHaveProperty('checkServerIdentity');
			expect(tlsOpts).not.toHaveProperty('verifyPeerCertificate');
		});

		it.each(['report', 'enforce'] as const)(
			'mode %s with NO resolver => inert (resolver never consulted, no DANE hook)',
			async (mode) => {
				const result = await sendToMx(
					createJob(),
					createConfig({ daneMode: mode }),
					redis,
					'10.0.0.1'
				);

				expect(result.success).toBe(true);
				expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
				const tlsOpts = acquireOpts(0).tls ?? {};
				expect(tlsOpts).not.toHaveProperty('verifyPeerCertificate');
			}
		);

		it('DANE enabled but no usable TLSA => falls through to the non-DANE path', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({ status: 'no-tlsa' });

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).toHaveBeenCalled();
			expect(acquireOpts(0).tls ?? {}).not.toHaveProperty('verifyPeerCertificate');
		});

		it('applies provider policy to the MX hosts discovered through DANE', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'destinations',
				destinations: [
					{
						mxHostname: 'aspmx.l.google.com',
						preference: 10,
						mxSecurity: 'secure',
						addressSecurity: 'secure',
						addresses: ['192.0.2.1'],
					},
				],
			});
			vi.mocked(lookupTlsaRecords).mockResolvedValue({ status: 'no-tlsa' });

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireOpts()).toMatchObject({
				requireTLS: true,
				connectionLimits: { scope: 'provider:gmail' },
			});
		});

		it('a TLSA lookup FAILURE (SERVFAIL/outage) defers — never downgrades to non-DANE', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('an enforce-mode DNSSEC MX discovery failure defers before TLSA lookup', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'MX DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result).toMatchObject({ success: false, bounceType: 'deferred' });
			expect(result.error).toContain('DANE MX discovery failed');
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('an indeterminate address lookup defers in enforce mode instead of downgrading', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'destinations',
				destinations: [
					{
						mxHostname: 'mx.example.com',
						preference: 10,
						mxSecurity: 'secure',
						addressSecurity: 'indeterminate',
						addresses: [],
					},
				],
			});

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
			expect(result.error).toContain('address discovery indeterminate');
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('a report-mode MX discovery failure delivers normally without a misleading DANE probe', async () => {
			vi.mocked(resolveDaneMxDestinations).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'MX DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(vi.mocked(lookupTlsaRecords)).not.toHaveBeenCalled();
			expect(acquireOpts(0).tls ?? {}).not.toHaveProperty('verifyPeerCertificate');
		});

		it('DANE-EE uses the post-handshake verifier without requiring WebPKI', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			connectMock.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			const opts = acquireOpts(0);
			expect(opts.requireTLS).toBe(true);
			expect(opts.tls?.rejectUnauthorized).toBe(false);
			expect(typeof opts.tls?.verifyPeerCertificate).toBe('function');
			expect(opts.tls?.danePolicyFingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(opts.tls?.checkServerIdentity).toBeUndefined();
		});

		it('the DANE hook accepts a matching MX certificate and rejects a mismatch', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			const check = acquireOpts(0).tls!.verifyPeerCertificate!;
			expect(check(fixtureTlsSocket())).toBeUndefined();

			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');
			const mismatchCheck = acquireMock.mock.calls.at(-1)![2].tls.verifyPeerCertificate!;
			const verdict = mismatchCheck(fixtureTlsSocket());
			expect(verdict).toBeInstanceOf(Error);
			expect((verdict as Error).message).toContain('DANE TLSA mismatch');
		});

		it('a TLSA mismatch defers (soft bounce) and records a validation-failure under the tlsa policy', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			// The post-handshake verifier rejects → the client fails the connection
			// closed with tlsCause 'handshake' (a TLS failure with no reply code).
			connectMock.mockRejectedValue(
				smtpError({
					phase: 'starttls',
					message: 'peer certificate verification failed: DANE TLSA mismatch',
					tlsCause: 'handshake',
					secured: false,
				})
			);

			const result = await sendToMx(createJob(), daneConfig(), redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.policy['policy-string']).toContain(`3 1 1 ${MISMATCH_TLSA.data}`);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'validation-failure')).toBeDefined();
		});

		it('report + matching TLSA => delivers and emits a TLS-RPT success under the tlsa policy', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MATCHING_TLSA],
			});
			connectMock.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireMock).toHaveBeenCalledTimes(1);
			expect(typeof acquireOpts(0).tls?.verifyPeerCertificate).toBe('function');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.summary['total-successful-session-count']).toBe(1);
		});

		it('report + TLSA MISMATCH => NO bounce, NO DANE requireTLS on delivery, but the validation-failure is still emitted', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'records',
				records: [MISMATCH_TLSA],
			});
			// Probe (call 0) aborts on the TLSA mismatch; the report-only fallback
			// (call 1) delivers over the normal opportunistic floor.
			connectMock
				.mockRejectedValueOnce(
					smtpError({
						phase: 'starttls',
						message: 'peer certificate verification failed: DANE TLSA mismatch',
						tlsCause: 'handshake',
						secured: false,
					})
				)
				.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireMock).toHaveBeenCalledTimes(2);

			const probeOpts = acquireOpts(0);
			expect(probeOpts.requireTLS).toBe(true);
			expect(typeof probeOpts.tls?.verifyPeerCertificate).toBe('function');

			const deliverOpts = acquireOpts(1);
			expect(deliverOpts.requireTLS).toBe(false);
			expect(deliverOpts.tls ?? {}).not.toHaveProperty('verifyPeerCertificate');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('tlsa');
			expect(policy.policy['policy-string']).toContain(`3 1 1 ${MISMATCH_TLSA.data}`);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'validation-failure')).toBeDefined();
		});

		it('report + TLSA lookup FAILURE => delivers on the normal path (never defers)', async () => {
			vi.mocked(lookupTlsaRecords).mockResolvedValue({
				status: 'lookup-failed',
				reason: 'DNS RCODE 2',
			});

			const result = await sendToMx(createJob(), daneConfig('report'), redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(acquireOpts(0).tls ?? {}).not.toHaveProperty('verifyPeerCertificate');
		});
	});
});
