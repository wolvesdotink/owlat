import { describe, expect, it, vi } from 'vitest';
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
});
