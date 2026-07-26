import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
	default: {
		reverse: vi.fn(),
		resolve4: vi.fn(),
		resolve6: vi.fn(),
	},
}));
vi.mock('../../webhooks/convexNotifier.js', () => ({
	queueConvexWebhook: vi.fn(async () => undefined),
}));

import dns from 'node:dns/promises';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import { queueConvexWebhook } from '../../webhooks/convexNotifier.js';
import {
	deliverabilityProbeToken,
	forwardConfirmedPtr,
	recordDeliverabilityProbe,
} from '../deliverabilityProbe.js';
import { createDeliverabilityProbeToken } from '@owlat/shared/deliverabilityProbeToken';

const SECRET = 'probe-test-secret';
const NOW = 1_800_000_000_000;

describe('deliverability probe receiver', () => {
	beforeEach(() => vi.clearAllMocks());

	it('preserves mixed-case tokens and rejects a forged MAC, expiry, and another domain', () => {
		const token = createDeliverabilityProbeToken(
			SECRET,
			NOW + 15 * 60_000,
			Buffer.from([0, 16, 131, 8, 81, 135, 24, 146, 141])
		);
		const address = `DELIVERABILITY-PROBE+${token}@Bounces.Example`;
		expect(deliverabilityProbeToken(address, 'bounces.example', SECRET, NOW)).toBe(token);
		const forgedToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
		expect(
			deliverabilityProbeToken(
				`deliverability-probe+${forgedToken}@bounces.example`,
				'bounces.example',
				SECRET,
				NOW
			)
		).toBeNull();
		expect(
			deliverabilityProbeToken(address, 'bounces.example', SECRET, NOW + 16 * 60_000)
		).toBeNull();
		expect(deliverabilityProbeToken(address, 'custom.example', SECRET, NOW)).toBeNull();
	});

	it('uses bounded authoritative PTR answers and deterministically returns a confirmed name', async () => {
		vi.mocked(dns.reverse).mockResolvedValue([
			'Z.unconfirmed.example.',
			'a.confirmed.example.',
			'A.CONFIRMED.EXAMPLE.',
		]);
		vi.mocked(dns.resolve4).mockImplementation(async (hostname) =>
			hostname === 'a.confirmed.example' ? ['203.0.113.10'] : ['203.0.113.99']
		);
		expect(await forwardConfirmedPtr('203.0.113.10')).toBe('a.confirmed.example');
		expect(dns.resolve4).toHaveBeenCalledTimes(1);
		expect(dns.resolve6).not.toHaveBeenCalled();
	});

	it('queues only the forward-confirmed PTR observation', async () => {
		vi.mocked(dns.reverse).mockResolvedValue(['mail.example.']);
		vi.mocked(dns.resolve4).mockResolvedValue(['203.0.113.10']);
		await recordDeliverabilityProbe(
			{
				token: 'token',
				spfResult: 'pass',
				dkimResult: 'pass',
				dmarcResult: 'pass',
				remoteAddress: '203.0.113.10',
				tlsProtocol: 'TLSv1.3',
			},
			{} as MtaConfig,
			{} as Redis
		);
		expect(vi.mocked(queueConvexWebhook).mock.calls[0]?.[0]).toMatchObject({
			ptr: 'mail.example',
			ip: '203.0.113.10',
			tlsVersion: 'TLSv1.3',
		});
	});
});
