import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../checklistProviderDetection', () => ({
	detectIpProvider: vi.fn(async () => null),
}));

import { detectIpProvider } from '../checklistProviderDetection';
import { observeDeploymentCheck } from '../checklistDeploymentValidators';
import type { ChecklistVerificationContext } from '../checklistValidatorTypes';

function context(dnsblCheckedAt?: number): ChecklistVerificationContext {
	return {
		domain: null,
		settings: null,
		routes: [],
		relayIdentities: [],
		tracking: [],
		postmaster: null,
		warming: {
			syncedAt: Date.now(),
			phase: 'graduated',
			totalDailyCap: 1,
			totalSentToday: 0,
			ipCount: 1,
			ips: [
				{
					ip: '203.0.113.10',
					phase: 'graduated',
					currentDay: 30,
					dailyCap: 1,
					sentToday: 0,
					bounceRate: 0,
					deferralRate: 0,
					pool: 'campaign',
					active: true,
					dnsbl: 'clean',
					...(dnsblCheckedAt === undefined ? {} : { dnsblCheckedAt }),
				},
			],
		} as ChecklistVerificationContext['warming'],
	};
}

describe('deployment checklist validator freshness', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does not pass clean DNSBL state without a recent underlying check timestamp', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-26T12:00:00Z'));
		const now = Date.now();
		await expect(
			observeDeploymentCheck('deployment.dnsbl', context(), false)
		).resolves.toMatchObject({
			status: 'warn',
		});
		await expect(
			observeDeploymentCheck('deployment.dnsbl', context(now - 31 * 60_000), false)
		).resolves.toMatchObject({ status: 'warn' });
		await expect(
			observeDeploymentCheck('deployment.dnsbl', context(now - 29 * 60_000), false)
		).resolves.toMatchObject({ status: 'pass' });
		vi.useRealTimers();
	});

	it('evaluates the IPv4 port-25 proof independently from a failing IPv6 probe', async () => {
		const now = Date.now();
		const mixed = context(now);
		mixed.warming!.ips.push({
			...mixed.warming!.ips[0]!,
			ip: '2001:db8::10',
		});
		mixed.settings = {
			mtaHealth: {
				status: 'degraded',
				observedAt: now,
				smtpOutbound: {
					status: 'degraded',
					checkedAt: now,
					ips: [
						{ ip: '203.0.113.10', status: 'ok' },
						{ ip: '2001:db8::10', status: 'failed', reason: 'unroutable' },
					],
				},
			},
		} as ChecklistVerificationContext['settings'];
		await expect(observeDeploymentCheck('deployment.port25', mixed, false)).resolves.toMatchObject({
			status: 'pass',
			observedValues: ['203.0.113.10=ok'],
		});
	});

	it.each([
		['deployment.fcrdns', '203.0.113.10'],
		['deployment.ipv6_aaaa', '2001:db8::10'],
	] as const)('keeps a fresh %s mismatch pending until the final retry', async (itemId, ip) => {
		const now = Date.now();
		const mismatch = context(now);
		mismatch.warming!.ips = [
			{
				...mismatch.warming!.ips[0]!,
				ip,
				fcrdns: {
					ehlo: 'mail.example.test',
					ptrNames: ['ptr.example.test'],
					isPtrPresent: true,
					isPtrFqdn: true,
					isForwardConfirmed: false,
					isEhloMatched: false,
					verdict: 'fail',
					isGenericPtr: false,
					reason: 'forward-mismatch',
					checkedAt: now,
					isOverridden: false,
				},
			},
		];
		const pending = await observeDeploymentCheck(itemId, mismatch, false);
		expect(pending.status).toBe('pending-dns');
		expect(pending.observedValues).toEqual(
			expect.arrayContaining([
				`ip=${ip}`,
				'ptr=ptr.example.test',
				'ehlo=mail.example.test',
				'reason=forward-mismatch',
				`checked-at=${now}`,
			])
		);
		expect(pending.diagnostic).toContain('PTR ptr.example.test');
		await expect(observeDeploymentCheck(itemId, mismatch, true)).resolves.toMatchObject({
			status: 'fail',
		});
	});

	it('uses specific VPS guidance evidence only when every selected address agrees', async () => {
		const mixed = context(Date.now());
		mixed.warming!.ips.push({
			...mixed.warming!.ips[0]!,
			ip: '203.0.113.11',
		});
		vi.mocked(detectIpProvider).mockImplementation(async (ip) =>
			ip === '203.0.113.10' ? 'hetzner' : 'digitalocean'
		);
		const observation = await observeDeploymentCheck('deployment.ptr', mixed, false);
		expect(observation.observedValues).toContain('vps-provider=mixed-or-unknown');
		expect(observation.observedValues).not.toContain('vps-provider=hetzner');
		expect(observation.observedValues).not.toContain('vps-provider=digitalocean');
		expect(detectIpProvider).toHaveBeenCalledTimes(2);
	});
});
