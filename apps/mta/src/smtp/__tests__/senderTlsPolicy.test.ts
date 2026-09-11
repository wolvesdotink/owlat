/**
 * TLS phase (smtp/send/tlsPlan.ts): how the recipient's MTA-STS state reaches
 * the acquire, how an enforce policy skips a non-listed MX, and what each
 * outcome records in TLS-RPT — read back through the real generateReport.
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
import { SmtpError, type SmtpConnection } from '@owlat/smtp-client';
import { pool } from '../connectionPool.js';
import { getStsTlsOptions } from '../mtaSts.js';
import { logger } from '../../monitoring/logger.js';
import {
	acquireCallOptions,
	createConfig,
	createJob,
	installSenderDefaults,
	liveConn,
	smtpError,
	tlsRptReportFor,
} from './helpers/senderFixtures.js';

describe('sendToMx TLS policy', () => {
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

	describe('MTA-STS enforce policy is carried into the acquire (PR-25 item 2)', () => {
		it('passes requireTLS:true + tls.rejectUnauthorized:true when the policy enforces', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx1.example.com', 'mx2.example.com'],
				policyMode: 'enforce',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(acquireMock).toHaveBeenCalledWith(
				'mx1.example.com',
				'10.0.0.1',
				expect.objectContaining({
					requireTLS: true,
					tls: expect.objectContaining({ rejectUnauthorized: true, minVersion: 'TLSv1.2' }),
				})
			);
		});

		it('skips (and logs) an MX host not listed in the enforce policy, delivering via the permitted one', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx2.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			const acquiredHosts = acquireMock.mock.calls.map((c) => c[0]);
			expect(acquiredHosts).not.toContain('mx1.example.com');
			expect(acquiredHosts).toContain('mx2.example.com');
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				expect.objectContaining({ mxHost: 'mx1.example.com' }),
				expect.stringContaining('not permitted by MTA-STS policy')
			);
		});

		it('all MX hosts excluded by the policy => no acquire, soft bounce (retryable)', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['mx-elsewhere.example.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			expect(acquireMock).not.toHaveBeenCalled();
		});
	});

	describe('multi-MX TLS failover (PR-25 item 5)', () => {
		// A STARTTLS handshake failure surfaces as an SmtpError with a structured
		// tlsCause and no reply code — a transient error the loop treats as "try
		// the next MX" (RFC 5321 §4.5.4.1), never a hard bounce.
		const tlsHandshakeError = () =>
			smtpError({
				phase: 'starttls',
				message: 'handshake failure',
				tlsCause: 'handshake',
				secured: false,
			});

		it('first MX fails on TLS, second MX resolves => success', async () => {
			connectMock.mockRejectedValueOnce(tlsHandshakeError()).mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			expect(connectMock).toHaveBeenCalledTimes(2); // tried both MX
			expect(sendEnvelopeMock).toHaveBeenCalledTimes(1);
		});

		it('every MX fails on TLS => soft bounce (retryable) + TLS-RPT validation-failure recorded', async () => {
			connectMock.mockRejectedValue(tlsHandshakeError());

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(result.bounceType).toBe('soft');
			expect(connectMock).toHaveBeenCalledTimes(2);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBe(2);
			const details = policy['failure-details']!;
			const validationFailures = details.filter((d) => d['result-type'] === 'validation-failure');
			expect(validationFailures.length).toBe(2);
			const recordedHosts = validationFailures.map((d) => d['receiving-mx-hostname']);
			expect(recordedHosts).toContain('mx1.example.com');
			expect(recordedHosts).toContain('mx2.example.com');
		});
	});

	describe('MTA-STS enforce wiring (PR-35)', () => {
		it('forwards enforce requireTLS + rejectUnauthorized to acquire unchanged', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(acquireOpts(0).requireTLS).toBe(true);
			expect(acquireOpts(0).tls?.rejectUnauthorized).toBe(true);
		});

		it('an opportunistic (none) policy forwards requireTLS:false / rejectUnauthorized:false', async () => {
			await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(acquireOpts(0).requireTLS).toBe(false);
			expect(acquireOpts(0).tls?.rejectUnauthorized).toBe(false);
		});

		it('a requireTLS send to a server with no STARTTLS soft/deferred-bounces (not a hard bounce)', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});
			connectMock.mockRejectedValue(
				smtpError({
					phase: 'starttls',
					message: 'server does not advertise STARTTLS but TLS is required',
					tlsCause: 'starttls-unavailable',
					secured: false,
				})
			);

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(['soft', 'deferred']).toContain(result.bounceType);
			expect(result.bounceType).not.toBe('hard');
		});
	});

	describe('MTA-STS TLS-RPT recording', () => {
		it('records sts-policy-invalid for an enforce policy MX not in the policy (was previously inert)', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['aspmx.l.google.com'],
				policyMode: 'enforce',
			});

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(false);
			expect(acquireMock).not.toHaveBeenCalled();

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			expect(policy.policy['policy-string']).toContain('mode: enforce');
			expect(policy.policy['mx-host']).toEqual(['aspmx.l.google.com']);
			const details = policy['failure-details']!;
			expect(
				details.filter((d) => d['result-type'] === 'sts-policy-invalid').length
			).toBeGreaterThanOrEqual(1);
			expect(policy.summary['total-failure-session-count']).toBeGreaterThanOrEqual(1);
		});

		it('attributes a cert hostname mismatch under enforce as sts-webpki-invalid', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: true,
				rejectUnauthorized: true,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'enforce',
			});
			connectMock.mockRejectedValue(
				smtpError({
					phase: 'starttls',
					message: 'Hostname/IP does not match certificate altname',
					tlsCause: 'cert-host-mismatch',
					secured: false,
				})
			);

			await sendToMx(createJob(), config, redis, '10.0.0.1');

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-webpki-invalid')).toBeDefined();
			expect(details.find((d) => d['result-type'] === 'certificate-host-mismatch')).toBeUndefined();
		});

		it('testing mode + STARTTLS-stripping server: records a failure but still delivers', async () => {
			vi.mocked(getStsTlsOptions).mockResolvedValue({
				requireTLS: false,
				rejectUnauthorized: false,
				allowedMxHosts: ['*.example.com'],
				policyMode: 'testing',
			});
			// The verifying probe (requireTLS:true) fails because STARTTLS is stripped;
			// the opportunistic retry on the same MX then delivers in cleartext.
			connectMock
				.mockRejectedValueOnce(
					smtpError({
						phase: 'starttls',
						message: 'server does not advertise STARTTLS but TLS is required',
						tlsCause: 'starttls-unavailable',
						secured: false,
					})
				)
				.mockResolvedValue(liveConn(false));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

			expect(result.success).toBe(true);
			// probe + opportunistic retry on the same MX.
			expect(connectMock).toHaveBeenCalledTimes(2);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.policy['policy-type']).toBe('sts');
			// The cleartext retry is NOT a TLS success (PR-24): both the stripped probe
			// and the cleartext retry are STS-attributed sts-policy-invalid.
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBeGreaterThanOrEqual(1);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'sts-policy-invalid')).toBeDefined();
		});
	});

	describe('TLS-RPT records the real session result type per delivery (PR-24)', () => {
		it('records starttls-not-supported (not success) for a cleartext delivery with no policy', async () => {
			// The connection never negotiated STARTTLS → secured stays false → a
			// plaintext session, recorded as starttls-not-supported (never success).
			connectMock.mockResolvedValue(liveConn(false));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(0);
			expect(policy.summary['total-failure-session-count']).toBe(1);
			const details = policy['failure-details']!;
			expect(details.find((d) => d['result-type'] === 'starttls-not-supported')).toBeDefined();
			expect(details.find((d) => d['result-type'] === 'success')).toBeUndefined();
		});

		it('records a TLS success when the connection negotiated STARTTLS', async () => {
			connectMock.mockResolvedValue(liveConn(true));

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true);

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(1);
			expect(policy.summary['total-failure-session-count']).toBe(0);
		});

		it('records the per-message TLS success on a REUSED (checked-out) secured connection', async () => {
			// The reuse path: takeConnection returns a live, secured socket, so the sender
			// never calls connect — but the TLS-RPT result must still be recorded from the
			// reused connection's own `secured` state (attribution is per-connection, and
			// every message carried over it inherits that state).
			const reused = liveConn(true);
			vi.mocked(pool.takeConnection).mockResolvedValueOnce(reused as unknown as SmtpConnection);

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(true);
			expect(connectMock).not.toHaveBeenCalled(); // reused, not reconnected

			const report = await reportFor();
			const policy = report.policies[0]!;
			expect(policy.summary['total-successful-session-count']).toBe(1);
			expect(policy.summary['total-failure-session-count']).toBe(0);
		});
	});
});
