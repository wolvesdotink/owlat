/**
 * T1 — end-to-end proof that OUTBOUND_TLS_MODE raises the sender's handshake
 * demand and, when a required TLS floor cannot be met, produces a SOFT BOUNCE
 * (never a cleartext fallback) with the TLS failure both named in the error and
 * RECORDED in TLS-RPT.
 *
 * Unlike the pool-level extension in outboundStartTls.integration.test.ts (which
 * proves the resolver → classification mapping in isolation), this drives the
 * FULL {@link sendToMx} through the REAL {@link SmtpConnectionPool} + real
 * nodemailer + real tlsRpt (over ioredis-mock) against a loopback
 * {@link SMTPServer}, exactly like senderPlaintextTlsRpt.integration.test.ts.
 * Both suites share the loopback harness (loopbackMxHarness.ts); only the
 * destination port is rewritten (sendToMx hardcodes 25).
 *
 *  - `require` vs a receiver that offers no STARTTLS ⇒ soft bounce +
 *    `starttls-not-supported` recorded.
 *  - `require-verified` vs a self-signed MX (advertising STARTTLS) ⇒ soft bounce
 *    + `certificate-not-trusted` recorded.
 *  - `opportunistic` (the default) against the SAME broken receiver still
 *    delivers — the floor switch is what changes the outcome, and the default is
 *    byte-identical to today.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../mxResolver.js', () => ({
	getMxHostnames: vi.fn().mockResolvedValue(['127.0.0.1']),
}));
vi.mock('../mtaSts.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../mtaSts.js')>();
	return {
		...actual,
		// No MTA-STS policy — the ONLY thing raising the floor here is the local
		// OUTBOUND_TLS_MODE, so the test isolates the T1 behaviour.
		getStsTlsOptions: vi.fn().mockResolvedValue({
			requireTLS: false,
			rejectUnauthorized: false,
			allowedMxHosts: [],
			policyMode: 'none',
		}),
	};
});
vi.mock('../dkim.js', () => ({
	getDkimOptions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../bounce/verp.js', () => ({
	buildVerpAddress: vi.fn().mockReturnValue('bounce+encoded@bounces.owlat.com'),
}));
vi.mock('../../queue/groups.js', () => ({
	extractDomain: vi.fn().mockReturnValue('recipient.test'),
	buildGroupKey: vi.fn((pool: string, domain: string) => `${pool}:${domain}`),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendToMx } from '../sender.js';
import { pool } from '../connectionPool.js';
import { generateReport } from '../tlsRpt.js';
import {
	type ServerProbe,
	startServer,
	stopServer,
	createJob,
	createConfig,
	flush,
} from './loopbackMxHarness.js';

describe('sendToMx honours OUTBOUND_TLS_MODE: bounce + TLS-RPT under a required floor (T1)', () => {
	let redis: InstanceType<typeof Redis>;
	let probe: ServerProbe | undefined;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		const realAcquire = pool.acquire.bind(pool);
		vi.spyOn(pool, 'acquire').mockImplementation((mxHost, bindIp, options) =>
			realAcquire(mxHost, bindIp, { ...options, port: probe!.port })
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await pool.closeAll(500);
		if (probe) await stopServer(probe.server);
		probe = undefined;
	});

	async function failureTypes(): Promise<string[]> {
		await flush();
		const today = new Date().toISOString().split('T')[0]!;
		const report = await generateReport(
			redis as unknown as Parameters<typeof generateReport>[0],
			'recipient.test',
			today,
			'Owlat MTA',
			'postmaster@owlat.com'
		);
		expect(report).not.toBeNull();
		const policy = report!.policies[0]!;
		return (policy['failure-details'] ?? []).map((d) => d['result-type']);
	}

	it('require: a receiver that offers no STARTTLS soft-bounces and records starttls-not-supported', async () => {
		probe = await startServer({ advertiseStartTls: false });

		const result = await sendToMx(
			createJob(),
			createConfig({ outboundTlsMode: 'require' }),
			redis,
			'127.0.0.1'
		);

		// A required TLS floor never falls back to cleartext: the body never reached
		// the server and the send is a retryable soft bounce naming the TLS failure.
		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(result.error).toContain('TLS required');
		expect(probe.dataReached()).toBe(false);

		expect(await failureTypes()).toContain('starttls-not-supported');
	}, 15000);

	it('require-verified: a self-signed MX soft-bounces and records certificate-not-trusted', async () => {
		probe = await startServer({ advertiseStartTls: true });

		const result = await sendToMx(
			createJob(),
			createConfig({ outboundTlsMode: 'require-verified' }),
			redis,
			'127.0.0.1'
		);

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('soft');
		expect(result.error).toContain('TLS required');
		expect(probe.dataReached()).toBe(false);

		expect(await failureTypes()).toContain('certificate-not-trusted');
	}, 15000);

	it('opportunistic (default): the SAME no-STARTTLS receiver still gets the mail — the floor switch is what changes the outcome', async () => {
		probe = await startServer({ advertiseStartTls: false });

		const result = await sendToMx(
			createJob(),
			createConfig({ outboundTlsMode: 'opportunistic' }),
			redis,
			'127.0.0.1'
		);

		// Byte-identical to today: opportunistic delivers over cleartext rather than
		// bouncing, and the cleartext session is recorded as starttls-not-supported
		// (never a required-TLS bounce).
		expect(result.success).toBe(true);
		expect(probe.dataReached()).toBe(true);
		expect(await failureTypes()).toContain('starttls-not-supported');
	}, 15000);
});
