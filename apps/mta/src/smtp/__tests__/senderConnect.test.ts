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
vi.mock('../mxAddresses.js', async (importOriginal) =>
	harness.mxAddressesModule(await importOriginal<Record<string, unknown>>())
);
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
	resolveAddressesMock,
} = harness;

import { sendToMx } from '../sender.js';
import type { MtaConfig } from '../../config.js';
import { hostname as osHostname } from 'node:os';
import type { SmtpConnection } from '@owlat/smtp-client';
import { pool } from '../connectionPool.js';
import { resolveMxDestination } from '../mxResolver.js';
import { createMxAddressResolver } from '../mxAddresses.js';
import { classifyResult } from '../../dispatch/outcomeClassification.js';
import { dispatchOutcomeCause } from '../../intelligence/bounceCause.js';
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

	/**
	 * Resolve MX hosts through the REAL screening and family logic over a fake
	 * DNS: `answers[host]` is `{ a, aaaa }`, each a list of addresses or a DNS
	 * error code. A missing host is NXDOMAIN.
	 */
	function dns(answers: Record<string, { a?: string[] | string; aaaa?: string[] | string }>) {
		const lookup = (family: 'a' | 'aaaa') => async (host: string) => {
			const answer = answers[host]?.[family];
			if (answer === undefined || typeof answer === 'string') {
				throw Object.assign(new Error(answer ?? 'queryA ENOTFOUND'), {
					code: answer ?? 'ENOTFOUND',
				});
			}
			return answer.map((address) => ({ address, ttl: 300 }));
		};
		const resolver = createMxAddressResolver({ resolve4: lookup('a'), resolve6: lookup('aaaa') });
		resolveAddressesMock.mockImplementation((host: string, options: { allowPrivate: boolean }) =>
			resolver.resolve(host, options)
		);
	}
	const connectedHosts = () =>
		connectMock.mock.calls.map((call) => (call[0] as { host: string }).host);

	describe('source and destination address family', () => {
		it('an IPv4 source connects to the IPv4 address of an MX that lists AAAA first', async () => {
			dns({
				'mx1.example.com': { aaaa: ['2001:db8::25'], a: ['192.0.2.25'] },
				'mx2.example.com': { aaaa: ['2001:db8::26'], a: ['192.0.2.26'] },
			});

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result.success).toBe(true);
			expect(connectedHosts()).toEqual(['192.0.2.25']);
		});

		it('pins IPv4 when the pool IP is IPv4 and no source address is bound (NAT)', async () => {
			dns({ 'mx1.example.com': { aaaa: ['2001:db8::25'], a: ['192.0.2.25'] } });
			acquireMock.mockImplementation((mxHost: string, bindIp: string) => ({
				key: `${mxHost}:${bindIp}`,
				config: { host: mxHost, port: 25, ehloName: 'mail.owlat.test', tlsMode: 'starttls' },
			}));

			await sendToMx(createJob(), config, redis, '198.51.100.7');

			const connected = connectMock.mock.calls[0]![0] as { host: string; localAddress?: string };
			expect(connected.localAddress).toBeUndefined();
			expect(connected.host).toBe('192.0.2.25');
		});

		it('an IPv6 source connects to the IPv6 address', async () => {
			dns({ 'mx1.example.com': { a: ['192.0.2.25'], aaaa: ['2001:db8::25'] } });

			await sendToMx(createJob(), config, redis, '2001:db8:1::7');

			expect(connectedHosts()).toEqual(['2001:db8::25']);
		});

		it('an IPv6 source and an A-only MX set defer without opening a socket', async () => {
			dns({
				'mx1.example.com': { a: ['192.0.2.25'], aaaa: 'ENODATA' },
				'mx2.example.com': { a: ['192.0.2.26'], aaaa: 'ENODATA' },
			});

			const result = await sendToMx(createJob(), config, redis, '2001:db8:1::7');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
			expect(result.error).toContain("sending IP's family");
			expect(acquireMock).not.toHaveBeenCalled();
			expect(connectMock).not.toHaveBeenCalled();
		});

		it('keeps the MX hostname as the TLS server name while dialling the literal', async () => {
			dns({ 'mx1.example.com': { a: ['192.0.2.25'] } });

			await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(connectMock.mock.calls[0]![0]).toMatchObject({
				host: '192.0.2.25',
				tls: { servername: 'mx1.example.com', minVersion: 'TLSv1.2' },
			});
		});

		it('tries the next address of the same host when a TCP connect fails', async () => {
			dns({ 'mx1.example.com': { a: ['192.0.2.25', '192.0.2.26'] } });
			connectMock.mockRejectedValueOnce(
				smtpError({ phase: 'connect', message: 'connect ECONNREFUSED', secured: false })
			);

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result.success).toBe(true);
			expect(connectedHosts()).toEqual(['192.0.2.25', '192.0.2.26']);
			expect(acquireMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('non-public MX addresses', () => {
		it.each([
			['127.0.0.1', { a: ['127.0.0.1'] }],
			['10.0.0.0/8', { a: ['10.1.2.3'] }],
			['::1', { aaaa: ['::1'] }],
			['fe80::/10', { aaaa: ['fe80::1'] }],
			['IPv4-mapped 10.0.0.1', { aaaa: ['::ffff:10.0.0.1'] }],
		])('never connects to an MX that resolves to %s and hard-bounces 5.4.4', async (_, answer) => {
			dns({ 'mx1.example.com': answer, 'mx2.example.com': answer });

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(acquireMock).not.toHaveBeenCalled();
			expect(connectMock).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				success: false,
				bounceType: 'hard',
				smtpCode: 550,
				enhancedCode: '5.4.4',
			});
			expect(result.smtpPhase).toBeUndefined();
		});

		it('blames the recipient domain, not our sending identity, even for a domain named like spam', async () => {
			dns({ 'mx1.spam-rdns.example': { a: ['10.0.0.5'] } });
			vi.mocked(resolveMxDestination).mockResolvedValue({
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'mx1.spam-rdns.example', priority: 0 }],
			});

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');
			const outcome = classifyResult(result);

			// A recipient-side terminal bounce: the reducer suppresses the address
			// with this reason attached, like a Null MX or NXDOMAIN bounce.
			expect(outcome).toMatchObject({ kind: 'hard_bounce', enhancedCode: '5.4.4' });
			expect(dispatchOutcomeCause(outcome)).toBe('recipient');
			expect(result.error).toContain('private');
		});

		it('skips a private host and delivers through a public one', async () => {
			dns({
				'mx1.example.com': { a: ['192.168.1.10'] },
				'mx2.example.com': { a: ['192.0.2.26'] },
			});

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result.success).toBe(true);
			expect(connectedHosts()).toEqual(['192.0.2.26']);
		});

		it('only connects to the public addresses of a host that has both kinds', async () => {
			dns({ 'mx1.example.com': { a: ['10.0.0.5', '192.0.2.25'] } });

			await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(connectedHosts()).toEqual(['192.0.2.25']);
		});

		it('defers, not bounces, when one host is private and the other is unreachable', async () => {
			dns({
				'mx1.example.com': { a: ['10.0.0.5'] },
				'mx2.example.com': { a: ['192.0.2.26'] },
			});
			connectMock.mockRejectedValue(
				smtpError({ phase: 'connect', message: 'connect ETIMEDOUT', secured: false })
			);

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
		});

		it('connects to a private MX when MTA_ALLOW_PRIVATE_MX is set', async () => {
			dns({ 'mx1.example.com': { a: ['127.0.0.1'] } });

			const result = await sendToMx(
				createJob(),
				createConfig({ allowPrivateMxTargets: true }),
				redis,
				'127.0.0.1'
			);

			expect(result.success).toBe(true);
			expect(connectedHosts()).toEqual(['127.0.0.1']);
		});
	});

	describe('a recipient domain with no mail host', () => {
		const implicitMx = () =>
			vi.mocked(resolveMxDestination).mockResolvedValue({
				status: 'deliverable',
				source: 'implicit',
				hosts: [{ exchange: 'example.com', priority: 0 }],
			});

		it('hard-bounces 5.1.2 when there is no MX and the domain has no A or AAAA', async () => {
			implicitMx();
			dns({ 'example.com': { a: 'ENODATA', aaaa: 'ENODATA' } });

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result).toMatchObject({
				success: false,
				bounceType: 'hard',
				smtpCode: 550,
				enhancedCode: '5.1.2',
			});
			expect(acquireMock).not.toHaveBeenCalled();
		});

		it('defers when the address lookup of the implicit MX fails (SERVFAIL)', async () => {
			implicitMx();
			dns({ 'example.com': { a: 'ESERVFAIL', aaaa: 'ENODATA' } });

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
		});

		it('defers when an explicit MX host does not resolve', async () => {
			dns({});

			const result = await sendToMx(createJob(), config, redis, '198.51.100.7');

			expect(result).toMatchObject({ success: false, bounceType: 'soft' });
		});
	});
});
