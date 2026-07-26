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

	it('reports a fresh listed DNSBL result as a reputation finding, not stale telemetry', async () => {
		const listed = context(Date.now());
		listed.warming!.ips[0]!.dnsbl = 'critical';
		await expect(observeDeploymentCheck('deployment.dnsbl', listed, false)).resolves.toMatchObject({
			status: 'fail',
			diagnostic: expect.stringContaining('listed or has unknown standing'),
		});
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
		const raw = pending.observedValues.find((value) => value.startsWith(`ip=${ip};`));
		expect(raw).toContain('ptr=ptr.example.test');
		expect(raw).toContain('ehlo=mail.example.test');
		expect(raw).toContain('reason=forward-mismatch');
		expect(raw).toContain(`checked-at=${now}`);
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

	it.each([
		['deployment.ptr', '203.0.113.10'],
		['deployment.ptr_nongeneric', '203.0.113.10'],
		['deployment.ehlo_ptr', '203.0.113.10'],
		['deployment.ipv6_ptr', '2001:db8::10'],
	] as const)('preserves every required bounded identity field for %s', async (itemId, ip) => {
		const now = Date.now();
		const identity = context(now);
		identity.warming!.ips = [
			{
				...identity.warming!.ips[0]!,
				ip,
				fcrdns: {
					ehlo: `mail-${'e'.repeat(250)}.example.test`,
					ptrNames: Array.from(
						{ length: 4 },
						(_, index) => `ptr-${index}-${'p'.repeat(240)}.example.test`
					),
					isPtrPresent: true,
					isPtrFqdn: true,
					isForwardConfirmed: false,
					isEhloMatched: false,
					verdict: 'fail',
					isGenericPtr: true,
					reason: `mismatch-${'r'.repeat(300)}` as never,
					checkedAt: now,
					isOverridden: false,
				},
			},
		];

		const observation = await observeDeploymentCheck(itemId, identity, false);
		const raw = observation.observedValues.find((value) => value.startsWith(`ip=${ip};`));
		expect(raw).toBeDefined();
		expect(raw!.length).toBeLessThanOrEqual(512);
		expect(raw).toContain('ptr=');
		expect(raw).toContain('ehlo=');
		expect(raw).toContain('reason=');
		expect(raw).toContain(`checked-at=${now}`);
		expect(raw).toContain('…[length=');
	});

	it('retries a fresh IPv6 SPF mismatch before failing', async () => {
		const now = Date.now();
		const mismatch = context(now);
		mismatch.warming!.ips = [
			{
				...mismatch.warming!.ips[0]!,
				ip: '2001:db8::10',
				ipv6Spf: {
					domain: 'bounce.example.test',
					verdict: 'fail',
					reason: 'missing-exact-ip6',
					checkedAt: now,
				} as never,
			},
		];

		await expect(
			observeDeploymentCheck('deployment.ipv6_spf', mismatch, false)
		).resolves.toMatchObject({ status: 'pending-dns' });
		await expect(
			observeDeploymentCheck('deployment.ipv6_spf', mismatch, true)
		).resolves.toMatchObject({ status: 'fail' });
	});

	it('orders required identity evidence ahead of optional per-IP provider detail', async () => {
		const now = Date.now();
		const many = context(now);
		many.warming!.ips = Array.from({ length: 20 }, (_, index) => ({
			...many.warming!.ips[0]!,
			ip: `203.0.113.${index + 1}`,
			fcrdns: {
				ehlo: `mail-${index}.example.test`,
				ptrNames: [`ptr-${index}.example.test`],
				isPtrPresent: true,
				isPtrFqdn: true,
				isForwardConfirmed: true,
				isEhloMatched: true,
				verdict: 'pass' as const,
				isGenericPtr: false,
				checkedAt: now,
				isOverridden: false,
			},
		}));

		const observation = await observeDeploymentCheck('deployment.ptr', many, false);
		expect(observation.observedValues[0]).toBe('vps-provider=mixed-or-unknown');
		expect(observation.observedValues.slice(1, 16).every((value) => value.startsWith('ip='))).toBe(
			true
		);
		expect(observation.observedValues).not.toEqual(
			expect.arrayContaining([expect.stringContaining('vps-provider-ip=')])
		);
	});
});
