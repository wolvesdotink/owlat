/**
 * The reputation enforcement decision for fixed evidence and a fixed `now`.
 * `sendingReputation.integration.test.ts` holds the cron step to it.
 */
import { describe, expect, it } from 'vitest';
import { decideReputationEnforcement, type GmailSpamReading } from '../reputationEnforcement';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 12);
const YESTERDAY = Date.UTC(2026, 10, 13);

const CLEAN = { totalSent: 1000, bounceRate: 0.01, complaintRate: 0 };
const CRITICAL_BOUNCES = { totalSent: 1000, bounceRate: 0.12, complaintRate: 0 };
const HIGH_BOUNCES = { totalSent: 1000, bounceRate: 0.06, complaintRate: 0 };

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
		expect(decideReputationEnforcement({ org: CLEAN, gmail: [reading()], now: NOW })).toBeNull();
	});

	it('keeps the internal window’s calls and their wording', () => {
		expect(decideReputationEnforcement({ org: CRITICAL_BOUNCES, gmail: [], now: NOW })).toEqual({
			riskLevel: 'critical',
			reason: 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds',
			trigger: { code: 'bounce_rate' },
		});
		expect(decideReputationEnforcement({ org: HIGH_BOUNCES, gmail: [], now: NOW })?.riskLevel).toBe(
			'high'
		);
	});

	it('suspends at exactly the hard line and warns at exactly the guidance line', () => {
		expect(
			decideReputationEnforcement({
				org: CLEAN,
				gmail: [reading({ userReportedSpamRatio: 0.003 })],
				now: NOW,
			})
		).toEqual({
			riskLevel: 'critical',
			reason:
				"Auto-suspended: Gmail reports a spam rate of 0.30% for news.example.com on 2026-11-13, at or above Google's 0.30% limit",
			trigger: { code: 'gmail_spam_rate', domain: 'news.example.com' },
		});
		expect(
			decideReputationEnforcement({
				org: CLEAN,
				gmail: [reading({ userReportedSpamRatio: 0.001 })],
				now: NOW,
			})?.riskLevel
		).toBe('high');
	});

	it('a Gmail suspension outranks an internal warning', () => {
		const decision = decideReputationEnforcement({
			org: HIGH_BOUNCES,
			gmail: [reading({ userReportedSpamRatio: 0.004 })],
			now: NOW,
		});
		expect(decision?.riskLevel).toBe('critical');
		expect(decision?.reason).toContain('Gmail reports');
	});

	it('names the worst domain', () => {
		const decision = decideReputationEnforcement({
			org: CLEAN,
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
			expect(decideReputationEnforcement({ org: CLEAN, gmail: [stale], now: NOW })).toBeNull();
		}
	});

	it('gives the same answer for the same input', () => {
		const input = {
			org: { totalSent: 1000, bounceRate: 0.03, complaintRate: 0 },
			gmail: [reading({ userReportedSpamRatio: 0.002 })],
			now: NOW,
		};
		expect(decideReputationEnforcement(input)).toEqual(decideReputationEnforcement(input));
	});

	it('names the metric that crossed the line, and judges nothing below the sample size', () => {
		expect(
			decideReputationEnforcement({
				org: { totalSent: 1000, bounceRate: 0, complaintRate: 0.004 },
				gmail: [],
				now: NOW,
			})?.trigger
		).toEqual({ code: 'complaint_rate' });
		expect(
			decideReputationEnforcement({
				org: { totalSent: 99, bounceRate: 0.5, complaintRate: 0.5 },
				gmail: [],
				now: NOW,
			})
		).toBeNull();
	});

	it('leaves out what a manual lift put on hold, until the hold ends', () => {
		const hold = { until: NOW + HOUR, triggers: [{ code: 'bounce_rate' as const }] };
		expect(
			decideReputationEnforcement({ org: CRITICAL_BOUNCES, gmail: [], now: NOW, hold })
		).toBeNull();
		expect(
			decideReputationEnforcement({ org: CRITICAL_BOUNCES, gmail: [], now: NOW + HOUR, hold })
				?.riskLevel
		).toBe('critical');
		const gmailHold = {
			until: NOW + HOUR,
			triggers: [{ code: 'gmail_spam_rate' as const, domain: 'a.example.com' }],
		};
		expect(
			decideReputationEnforcement({
				org: CLEAN,
				gmail: [reading({ domain: 'b.example.com', userReportedSpamRatio: 0.004 })],
				now: NOW,
				hold: gmailHold,
			})?.trigger
		).toEqual({ code: 'gmail_spam_rate', domain: 'b.example.com' });
	});
});
