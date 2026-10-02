import { describe, expect, it } from 'vitest';
import {
	formatPassRate,
	passRateTone,
	readinessState,
	sourcePassRate,
	trendBars,
} from '../dmarcReportView';

describe('formatPassRate', () => {
	it('never rounds a near-miss up to 100%', () => {
		expect(formatPassRate(0.9996)).toBe('99.9%');
		expect(formatPassRate(1)).toBe('100%');
		expect(formatPassRate(0.5)).toBe('50.0%');
		expect(formatPassRate(null)).toBe('—');
	});
});

describe('passRateTone', () => {
	it('draws the healthy line at the 99% enforcement threshold', () => {
		expect(passRateTone(0.99)).toBe('success');
		expect(passRateTone(0.95)).toBe('warning');
		expect(passRateTone(0.5)).toBe('error');
		expect(passRateTone(null)).toBe('neutral');
	});
});

describe('readinessState', () => {
	const base = { nextPolicy: 'quarantine', isReady: false, streakDays: 0, latestAlignedRate: 0.5 };
	it('maps the backend verdict onto one state', () => {
		expect(readinessState({ ...base, nextPolicy: null })).toBe('enforced');
		expect(readinessState({ ...base, latestAlignedRate: null })).toBe('no-data');
		expect(readinessState({ ...base, isReady: true, streakDays: 14 })).toBe('ready');
		expect(readinessState({ ...base, streakDays: 3, latestAlignedRate: 1 })).toBe('building');
		expect(readinessState(base)).toBe('failing');
		// A run cut short by a truncated read is neither building nor without data.
		expect(readinessState({ ...base, isIncomplete: true, streakDays: 13 })).toBe('incomplete');
		expect(readinessState({ ...base, isIncomplete: true, latestAlignedRate: null })).toBe(
			'incomplete'
		);
		expect(readinessState({ ...base, isIncomplete: true, isReady: true })).toBe('ready');
	});
});

describe('trendBars', () => {
	it('scales each day against the busiest one', () => {
		expect(
			trendBars([
				{ date: 'a', messageCount: 100, alignedCount: 90 },
				{ date: 'b', messageCount: 50, alignedCount: 50 },
				{ date: 'c', messageCount: 0, alignedCount: 0 },
			])
		).toEqual([
			{ date: 'a', passed: 90, failed: 10, passedShare: 0.9, failedShare: 0.1 },
			{ date: 'b', passed: 50, failed: 0, passedShare: 0.5, failedShare: 0 },
			{ date: 'c', passed: 0, failed: 0, passedShare: 0, failedShare: 0 },
		]);
		expect(sourcePassRate({ messageCount: 0, alignedCount: 0 })).toBeNull();
	});
});
