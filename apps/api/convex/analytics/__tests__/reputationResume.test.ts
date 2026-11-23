/**
 * When a suspension or a warning the reputation check set clears by itself, for fixed
 * evidence. `sendingReputation.integration.test.ts` holds the cron step to it.
 */
import { describe, expect, it } from 'vitest';
import { decideAutoClear, resumeCondition } from '../reputationResume';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);
const org = (bounceRate: number, complaintRate = 0, totalSent = 1000) => ({
	totalSent,
	bounceRate,
	complaintRate,
});

describe('resumeCondition', () => {
	it('clears an internal rate under the warning line, not under the suspension line', () => {
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(0.07), gmail: [] }, 'suspended')
		).toEqual({
			code: 'bounce_rate',
			limit: 0.05,
			current: 0.07,
			isClear: false,
			clearsAt: null,
		});
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(0.049), gmail: [] }, 'suspended').isClear
		).toBe(true);
		expect(
			resumeCondition({ code: 'complaint_rate' }, { org: org(0, 0.0024), gmail: [] }, 'suspended')
		).toMatchObject({ limit: 0.002, current: 0.0024, isClear: false });
	});

	it('clears a warning under the line below the warning line', () => {
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(0.03), gmail: [] }, 'warned')
		).toMatchObject({ limit: 0.02, current: 0.03, isClear: false });
		expect(
			resumeCondition({ code: 'complaint_rate' }, { org: org(0, 0.0009), gmail: [] }, 'warned')
		).toMatchObject({ limit: 0.001, isClear: true });
	});

	it('treats an empty window as cleared, but judges a small one by its rate', () => {
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(0, 0, 0), gmail: [] }, 'suspended')
		).toMatchObject({ current: null, isClear: true });
		expect(
			resumeCondition({ code: 'bounce_rate' }, { org: org(12 / 90, 0, 90), gmail: [] }, 'suspended')
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
			},
			'suspended'
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

describe('decideAutoClear', () => {
	const cleared = resumeCondition(
		{ code: 'bounce_rate' },
		{ org: org(0.01), gmail: [] },
		'suspended'
	);
	const base = {
		status: 'suspended',
		trigger: { code: 'bounce_rate' as const },
		isManualResumeRequired: false,
		call: null,
		condition: cleared,
	};

	it('resumes a check-imposed suspension whose trigger cleared', () => {
		expect(decideAutoClear(base)).toBe(true);
		expect(decideAutoClear({ ...base, call: 'high' })).toBe(true);
	});

	it.each([
		['the instance requires a platform admin', { isManualResumeRequired: true }],
		['other evidence still calls for a suspension', { call: 'critical' as const }],
		['nothing recorded who imposed it', { trigger: undefined }],
		['it is a ban', { status: 'banned' }],
		['its trigger has not cleared', { condition: { ...cleared, isClear: false } }],
	])('does not resume when %s', (_label, override) => {
		expect(decideAutoClear({ ...base, ...override })).toBe(false);
	});

	it('clears a check-set warning whose trigger cleared, whatever the manual-check setting says', () => {
		expect(decideAutoClear({ ...base, status: 'warned' })).toBe(true);
		expect(decideAutoClear({ ...base, status: 'warned', isManualResumeRequired: true })).toBe(true);
	});

	it.each([
		['other evidence still calls for a warning', { call: 'high' as const }],
		['other evidence calls for a suspension', { call: 'critical' as const }],
		['nothing recorded who set it', { trigger: undefined }],
	])('keeps a warning when %s', (_label, override) => {
		expect(decideAutoClear({ ...base, status: 'warned', ...override })).toBe(false);
	});
});
