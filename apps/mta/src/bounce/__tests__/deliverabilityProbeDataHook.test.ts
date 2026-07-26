import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@owlat/mail-auth', () => ({
	checkSpf: vi.fn(),
	dnsDmarcLookup: vi.fn(),
	verifyDkim: vi.fn(async () => ({
		result: 'pass',
		domain: 'example.test',
		signatures: [{ verdict: 'pass', selector: 's1' }],
	})),
	evaluateDmarc: vi.fn(async () => ({ result: 'pass', policy: 'reject' })),
}));
vi.mock('node:dns/promises', () => ({
	default: {
		reverse: vi.fn(async () => ['mail.example.test']),
		resolve4: vi.fn(async () => ['203.0.113.10']),
		resolve6: vi.fn(async () => []),
	},
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	queueConvexWebhook: vi.fn(async () => undefined),
}));
vi.mock('../pipeline.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../pipeline.js')>();
	return { ...actual, runPipeline: vi.fn(async () => ({ kind: 'dropSilently' })) };
});
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import { queueConvexWebhook } from '../../webhooks/convexNotifier.js';
import { runPipeline } from '../pipeline.js';
import { buildOnData } from '../server.js';
import { createDeliverabilityProbeToken } from '@owlat/shared/deliverabilityProbeToken';

const raw = Buffer.from(
	'From: Sender <sender@example.test>\r\nTo: probe@example.test\r\nSubject: Probe\r\n\r\nBody\r\n'
);
const config = {
	returnPathDomain: 'bounces.example.test',
	webhookSecret: 'probe-secret',
	inboundDkimEnabled: true,
	inboundDmarcEnabled: true,
	inboundArcEnabled: false,
} as MtaConfig;
const redis = {} as Redis;
const resolvers = { dkim: {}, dmarcTxt: {}, arc: {}, spf: {} } as never;

describe('deliverability probe DATA hook', () => {
	beforeEach(() => vi.clearAllMocks());

	it('queues authenticated evidence for an RCPT-accepted probe and ACKs it', async () => {
		const token = createDeliverabilityProbeToken(config.webhookSecret, Date.now() + 60_000);
		const handler = buildOnData(config, redis, resolvers);
		const result = await handler(raw, {
			rcptTo: [{ address: `deliverability-probe+${token}@${config.returnPathDomain}`, params: {} }],
			remoteAddress: '203.0.113.10',
			tlsProtocol: 'TLSv1.3',
			transaction: {
				spfResult: 'pass',
				envelopeFromDomain: 'example.test',
				deliverabilityProbeToken: token,
			},
		} as never);
		expect(result).toBeUndefined();
		expect(queueConvexWebhook).toHaveBeenCalledTimes(1);
		expect(vi.mocked(queueConvexWebhook).mock.calls[0]?.[0]).toMatchObject({
			event: 'deliverability.probe_observed',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			selector: 's1',
		});
		expect(runPipeline).not.toHaveBeenCalled();
	});

	it('does not queue probe evidence for ordinary mail and continues the normal pipeline', async () => {
		const handler = buildOnData(config, redis, resolvers);
		await handler(raw, {
			rcptTo: [{ address: 'ordinary@example.test', params: {} }],
			remoteAddress: '203.0.113.10',
			transaction: { spfResult: 'pass', envelopeFromDomain: 'example.test' },
		} as never);
		expect(queueConvexWebhook).not.toHaveBeenCalled();
		expect(runPipeline).toHaveBeenCalledTimes(1);
	});
});
