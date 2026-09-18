/**
 * Route phase (smtp/send/route.ts): what sendToMx does with the destination
 * snapshot — the three undeliverable MX statuses that never open a socket, and
 * the strictest-wins reconciliation between a stored provider snapshot and the
 * provider the live MX set actually names.
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
import { resolveMxDestination } from '../mxResolver.js';
import {
	acquireCallOptions,
	createConfig,
	createJob,
	installSenderDefaults,
} from './helpers/senderFixtures.js';

describe('sendToMx route resolution', () => {
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

	it('returns hard bounce when no MX records found', async () => {
		vi.mocked(resolveMxDestination).mockResolvedValue({
			status: 'domain-not-found',
			reason: 'Domain does not exist',
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result.success).toBe(false);
		expect(result.bounceType).toBe('hard');
		expect(result.smtpCode).toBe(550);
	});

	it('defers on a temporary MX resolver failure without opening SMTP', async () => {
		vi.mocked(resolveMxDestination).mockResolvedValue({
			status: 'temporary-failure',
			reason: 'Temporary MX lookup failure (SERVFAIL)',
		});

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result).toMatchObject({ success: false, bounceType: 'deferred', smtpCode: 451 });
		expect(acquireMock).not.toHaveBeenCalled();
	});

	it('returns the Null MX permanent failure without opening SMTP', async () => {
		vi.mocked(resolveMxDestination).mockResolvedValue({ status: 'null-mx' });

		const result = await sendToMx(createJob(), config, redis, '10.0.0.1');

		expect(result).toMatchObject({
			success: false,
			bounceType: 'hard',
			smtpCode: 556,
			enhancedCode: '5.1.10',
		});
		expect(acquireMock).not.toHaveBeenCalled();
	});

	it('raises TLS and uses the Gmail scope if a legacy unknown snapshot contains Google MX', async () => {
		const result = await sendToMx(
			createJob({ to: 'user@workspace.example' }),
			config,
			redis,
			'10.0.0.1',
			undefined,
			{
				recipientDomain: 'workspace.example',
				providerKey: 'other',
				throttleKey: 'workspace.example',
				mx: {
					status: 'deliverable',
					source: 'mx',
					hosts: [{ exchange: 'aspmx.l.google.com', priority: 10 }],
				},
				daneDiscoveryAuthenticated: true,
			}
		);

		expect(result.success).toBe(true);
		expect(acquireOpts()).toMatchObject({
			requireTLS: true,
			connectionLimits: { scope: 'provider:gmail' },
		});
		expect(resolveMxDestination).not.toHaveBeenCalled();
	});

	it('does not poison the Gmail scope if a legacy Gmail snapshot contains an unrelated MX', async () => {
		const result = await sendToMx(
			createJob({ to: 'user@workspace.example' }),
			config,
			redis,
			'10.0.0.1',
			undefined,
			{
				recipientDomain: 'workspace.example',
				providerKey: 'gmail',
				throttleKey: 'gmail',
				mx: {
					status: 'deliverable',
					source: 'mx',
					hosts: [{ exchange: 'mx.partner.example', priority: 10 }],
				},
				daneDiscoveryAuthenticated: true,
			}
		);

		expect(result.success).toBe(true);
		expect(acquireOpts()).toMatchObject({
			requireTLS: true,
			connectionLimits: { scope: 'mx:mx.partner.example' },
		});
	});
});
