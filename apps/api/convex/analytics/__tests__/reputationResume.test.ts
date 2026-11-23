/**
 * When a suspension the reputation check imposed lifts by itself, for fixed
 * evidence. `sendingReputation.integration.test.ts` holds the cron step to it.
 */
import { describe, expect, it } from 'vitest';
import { decideAutoResume, resumeCondition } from '../reputationResume';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);
const org = (bounceRate: number, complaintRate = 0, totalSent = 1000) => ({
	totalSent,
	bounceRate,
	complaintRate,
});

describe('resumeCondition', () => {
	it('clears an internal rate under the warning line, not under the suspension line', () => {
		expect(resumeCondition({ code: 'bounce_rate' }, { org: org(0.07), gmail: [] })).toEqual({
			code: 'bounce_rate',
			limit: 0.05,
			current: 0.07,
			isClear: false,
			clearsAt: null,
		});
		expect(resumeCondition({ code: 'bounce_rate' }, { org: org(0.049), gmail: [] }).isClear).toBe(
			true
		);
		expect(
			resumeCondition({ code: 'complaint_rate' }, { org: org(0, 0.0024), gmail: [] })
		).toMatchObject({ limit: 0.002, current: 0.0024, isClear: false });
	});

	it('treats an empty window as cleared, but judges a small one by its rate', () => {
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(0, 0, 0), gmail: [] })
		).toMatchObject({ current: null, isClear: true });
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(12 / 90, 0, 90), gmail: [] })
		).toMatchObject({ isClear: false });
	});

	it('clears Gmail once its last reading over the guidance leaves the window', () => {
		const condition = resumeCondition(
			{ code: 'gmail_spam_rate', domain: 'news.example.com' },
			{
				org: org(0),
				gmail: [
					{ domain: 'news.example.com', userReportedSpamRatio: 0.004, periodStart: NOW - 10 * DAY },
					{ domain: 'news.example.com', userReportedSpamRatio: 0.0002, periodStart: NOW - 2 * DAY },
					{ domain: 'other.example.com', userReportedSpamRatio: 0.009, periodStart: NOW - DAY },
				],
			}
		);
		expect(condition).toEqual({
			code: 'gmail_spam_rate',
			domain: 'news.example.com',
			limit: 0.001,
			current: 0.004,
			isClear: false,
			clearsAt: NOW + 20 * DAY,
		});
	});
});

describe('decideAutoResume', () => {
	const cleared = resumeCondition({ code: 'bounce_rate' }, { org: org(0.01), gmail: [] });

	it('resumes a check-imposed suspension whose trigger cleared', () => {
		expect(
			decideAutoResume({
				status: 'suspended',
				trigger: { code: 'bounce_rate' },
				isManualResumeRequired: false,
				isStillCritical: false,
				condition: cleared,
			})
		).toBe(true);
	});

	it.each([
		['the instance requires a platform admin', { isManualResumeRequired: true }],
		['other evidence still calls for a suspension', { isStillCritical: true }],
		['nothing recorded who imposed it', { trigger: undefined }],
		['it is a ban', { status: 'banned' as const }],
	])('does not resume when %s', (_label, override) => {
		expect(
			decideAutoResume({
				status: 'suspended',
				trigger: { code: 'bounce_rate' },
				isManualResumeRequired: false,
				isStillCritical: false,
				condition: cleared,
				...override,
			})
		).toBe(false);
	});
});
