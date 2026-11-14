/**
 * The reputation enforcement decision for fixed evidence and a fixed `now`.
 * `sendingReputation.integration.test.ts` holds the cron step to it.
 */
import { describe, expect, it } from 'vitest';
import { decideReputationEnforcement, type GmailSpamReading } from '../reputationEnforcement';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 12);
const YESTERDAY = Date.UTC(2026, 10, 13);

function reading(overrides: Partial<GmailSpamReading> = {}): GmailSpamReading {
	return {
		domain: 'news.example.com',
		userReportedSpamRatio: 0.0005,
		periodStart: YESTERDAY,
		fetchedAt: NOW - 2 * HOUR,
		...overrides,
	};
}

describe('decideReputationEnforcement', () => {
	it('holds nothing when neither the window nor Gmail is over a line', () => {
		expect(
			decideReputationEnforcement({ orgRiskLevel: 'low', gmail: [reading()], now: NOW })
		).toBeNull();
	});

	it('keeps the internal window’s calls and their wording', () => {
		expect(decideReputationEnforcement({ orgRiskLevel: 'critical', gmail: [], now: NOW })).toEqual({
			riskLevel: 'critical',
			reason: 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds',
		});
		expect(
			decideReputationEnforcement({ orgRiskLevel: 'high', gmail: [], now: NOW })?.riskLevel
		).toBe('high');
	});

	it('suspends at exactly the hard line and warns at exactly the guidance line', () => {
		expect(
			decideReputationEnforcement({
				orgRiskLevel: 'low',
				gmail: [reading({ userReportedSpamRatio: 0.003 })],
				now: NOW,
			})
		).toEqual({
			riskLevel: 'critical',
			reason:
				"Auto-suspended: Gmail reports a spam rate of 0.30% for news.example.com on 2026-11-13, at or above Google's 0.30% limit",
		});
		expect(
			decideReputationEnforcement({
				orgRiskLevel: 'low',
				gmail: [reading({ userReportedSpamRatio: 0.001 })],
				now: NOW,
			})?.riskLevel
		).toBe('high');
	});

	it('a Gmail suspension outranks an internal warning', () => {
		const decision = decideReputationEnforcement({
			orgRiskLevel: 'high',
			gmail: [reading({ userReportedSpamRatio: 0.004 })],
			now: NOW,
		});
		expect(decision?.riskLevel).toBe('critical');
		expect(decision?.reason).toContain('Gmail reports');
	});

	it('names the worst domain', () => {
		const decision = decideReputationEnforcement({
			orgRiskLevel: 'low',
			gmail: [
				reading({ domain: 'a.example.com', userReportedSpamRatio: 0.0035 }),
				reading({ domain: 'b.example.com', userReportedSpamRatio: 0.006 }),
			],
			now: NOW,
		});
		expect(decision?.reason).toContain('b.example.com');
	});

	it('ignores a reading fetched too long ago or about a day too long ago', () => {
		for (const stale of [
			reading({ userReportedSpamRatio: 0.009, fetchedAt: NOW - 49 * HOUR }),
			reading({ userReportedSpamRatio: 0.009, periodStart: NOW - 5 * 24 * HOUR }),
		]) {
			expect(
				decideReputationEnforcement({ orgRiskLevel: 'low', gmail: [stale], now: NOW })
			).toBeNull();
		}
	});

	it('gives the same answer for the same input', () => {
		const input = {
			orgRiskLevel: 'medium' as const,
			gmail: [reading({ userReportedSpamRatio: 0.002 })],
			now: NOW,
		};
		expect(decideReputationEnforcement(input)).toEqual(decideReputationEnforcement(input));
	});
});
