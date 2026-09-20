/**
 * Connect phase (smtp/send/connect.ts): the source-IP eligibility fences either
 * side of acquisition, the pinned TLS floor on every acquire, the per-IP EHLO
 * name, and what happens to a checked-out socket when the delivery fails.
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
import { hostname as osHostname } from 'node:os';
import type { SmtpConnection } from '@owlat/smtp-client';
import { pool } from '../connectionPool.js';
import {
	acquireCallOptions,
	createConfig,
	createJob,
	installSenderDefaults,
	liveConn,
	smtpError,
} from './helpers/senderFixtures.js';

describe('sendToMx connection handling', () => {
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

	it('does not acquire an SMTP connection after its source-IP eligibility lease is revoked', async () => {
		leaseValidMock.mockResolvedValue(false);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1', {
			ip: '10.0.0.1',
			eligibilityGeneration: 7,
		});

		expect(result).toMatchObject({ success: false, bounceType: 'deferred', smtpCode: 451 });
		expect(acquireMock).not.toHaveBeenCalled();
		expect(connectMock).not.toHaveBeenCalled();
	});

	it('closes an acquired connection when its source IP is quarantined before MAIL FROM', async () => {
		leaseValidMock
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const connection = liveConn(true);
		connectMock.mockResolvedValue(connection);

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1', {
			ip: '10.0.0.1',
			eligibilityGeneration: 7,
		});

		expect(result).toMatchObject({ success: false, bounceType: 'deferred', smtpCode: 451 });
		expect(acquireMock).toHaveBeenCalledTimes(1);
		expect(connectMock).toHaveBeenCalledTimes(1);
		expect(sendEnvelopeMock).not.toHaveBeenCalled();
		expect(evictConnectionMock).toHaveBeenCalledWith('mx1.example.com:10.0.0.1', connection);
	});

	it('pins tls.minVersion TLSv1.2 when acquiring an outbound connection (RFC 8996/9325)', async () => {
		await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(acquireMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.objectContaining({ tls: expect.objectContaining({ minVersion: 'TLSv1.2' }) })
		);
	});

	describe('per-IP EHLO hostname', () => {
		it('announces the mapped EHLO name for the bind IP', async () => {
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com', '10.0.0.2': 'mail2.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.1');

			expect(acquireMock).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.1',
				expect.objectContaining({ name: 'mail1.owlat.com' })
			);
		});

		it('falls back to the global EHLO name for an unmapped bind IP', async () => {
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.9');

			expect(acquireMock).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.9',
				expect.objectContaining({ name: 'fallback.owlat.com' })
			);
		});

		it('two bind IPs each announce their own distinct EHLO name', async () => {
			const mapped = createConfig({
				ehloHostname: 'fallback.owlat.com',
				ehloHostnames: { '10.0.0.1': 'mail1.owlat.com', '10.0.0.2': 'mail2.owlat.com' },
			});

			await sendToMx(createJob(), mapped, redis, '10.0.0.1');
			await sendToMx(createJob(), mapped, redis, '10.0.0.2');

			const namesByBindIp = new Map<string, string>();
			for (const call of acquireMock.mock.calls) {
				const bindIp = call[1] as string;
				const opts = call[2] as { name?: string };
				if (opts.name) namesByBindIp.set(bindIp, opts.name);
			}
			expect(namesByBindIp.get('10.0.0.1')).toBe('mail1.owlat.com');
			expect(namesByBindIp.get('10.0.0.2')).toBe('mail2.owlat.com');
		});

		it('announces config.ehloHostname for the bind IP when there is no per-IP override', async () => {
			const single = createConfig({ ehloHostname: 'mail.test.example', ehloHostnames: {} });

			await sendToMx(createJob(), single, redis, '10.0.0.1');

			expect(acquireMock).toHaveBeenCalledWith(
				expect.any(String),
				'10.0.0.1',
				expect.objectContaining({ name: 'mail.test.example' })
			);
			expect(acquireOpts(0).name).not.toBe(osHostname());
		});
	});

	describe('reused-socket disposition on a delivery failure (X1 park vs evict)', () => {
		it('parks the reused socket (entry survives) on a clean pre-DATA reply rejection', async () => {
			// A 550 all-recipients bounce is a clean reply on a protocol-healthy socket:
			// pre-X1 the pooled entry survived a bounce, so the socket is parked for reuse
			// (the next job's RSET clears the aborted transaction), never evicted.
			const reused = liveConn(true);
			vi.mocked(pool.takeConnection).mockResolvedValueOnce(reused as unknown as SmtpConnection);
			sendEnvelopeMock.mockRejectedValue(
				smtpError({
					phase: 'rcpt',
					message: '550 5.1.1 User unknown',
					replyCode: 550,
					secured: true,
				})
			);

			const result = await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(result.success).toBe(false); // still a bounce for THIS message
			expect(pool.storeConnection).toHaveBeenCalledWith(expect.any(String), reused);
			expect(pool.evictConnection).not.toHaveBeenCalled();
		});

		it('evicts the reused socket on a 421 channel-close reply', async () => {
			// 421 = the server is closing the transmission channel: the socket is gone,
			// so it must be evicted (never parked) even though it carried a reply code.
			const reused = liveConn(true);
			vi.mocked(pool.takeConnection).mockResolvedValueOnce(reused as unknown as SmtpConnection);
			sendEnvelopeMock.mockRejectedValue(
				smtpError({ phase: 'mail', message: '421 service closing', replyCode: 421, secured: true })
			);

			await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(pool.evictConnection).toHaveBeenCalledWith(expect.any(String), reused);
			expect(pool.storeConnection).not.toHaveBeenCalled();
		});

		it('evicts the reused socket on a DATA-phase ambiguity (no reply)', async () => {
			// A drop during/after DATA is the never-auto-retried ambiguous region: the
			// socket is poisoned and must be evicted, never reused.
			const reused = liveConn(true);
			vi.mocked(pool.takeConnection).mockResolvedValueOnce(reused as unknown as SmtpConnection);
			sendEnvelopeMock.mockRejectedValue(
				smtpError({ phase: 'data-final', message: 'connection dropped after DATA', secured: true })
			);

			await sendToMx(createJob(), config, redis, '10.0.0.1');
			expect(pool.evictConnection).toHaveBeenCalledWith(expect.any(String), reused);
			expect(pool.storeConnection).not.toHaveBeenCalled();
		});
	});
});
