import { describe, expect, it } from 'vitest';
import {
	normalizeSpamScore,
	scoreSpam,
	SPAM_FAIL_THRESHOLD,
	SPAM_SCORE_MAX,
} from '../engine/spamScore';
import { CLEAN_EMAIL, SPAMMY_EMAIL } from './fixtures';

describe('scoreSpam', () => {
	it('passes a clean, well-formed newsletter with a zero score', () => {
		const report = scoreSpam(CLEAN_EMAIL);
		expect(report.score).toBe(0);
		expect(report.verdict).toBe('pass');
		expect(report.findings).toHaveLength(0);
	});

	it('fails a shouty, trigger-word-laden promo and marks its findings as blockers', () => {
		const report = scoreSpam(SPAMMY_EMAIL);
		expect(report.verdict).toBe('fail');
		expect(report.score).toBeGreaterThanOrEqual(SPAM_FAIL_THRESHOLD);
		expect(report.findings.every((finding) => finding.severity === 'fail')).toBe(true);
		expect(report.findings.map((finding) => finding.code)).toContain('trigger_phrases');
	});

	it('is deterministic — the same email always yields the same score', () => {
		expect(scoreSpam(SPAMMY_EMAIL)).toEqual(scoreSpam(SPAMMY_EMAIL));
	});

	it('caps the score so no single message can produce an unbounded value', () => {
		const flooded = {
			from: 'x@y.example',
			subject: 'ACT NOW BUY NOW CLICK HERE FREE MONEY WINNER GUARANTEED!!!',
			html: '<p>viagra congratulations 100% free risk free limited time no obligation</p>',
		};
		expect(scoreSpam(flooded).score).toBeLessThanOrEqual(SPAM_SCORE_MAX);
	});

	it('flags an HTML-only message with no plain-text alternative', () => {
		const report = scoreSpam({
			from: 'a@b.example',
			subject: 'Hello there friend',
			html: '<p>This is a perfectly reasonable amount of readable body text for a note.</p>',
		});
		expect(report.findings.map((finding) => finding.code)).toContain('missing_text_part');
	});

	describe('normalizeSpamScore', () => {
		it('maps a zero score to 0 and the max score to 1', () => {
			expect(normalizeSpamScore(0)).toBe(0);
			expect(normalizeSpamScore(SPAM_SCORE_MAX)).toBe(1);
		});

		it('clamps out-of-range and non-finite inputs into [0,1]', () => {
			expect(normalizeSpamScore(-5)).toBe(0);
			expect(normalizeSpamScore(Number.NaN)).toBe(0);
			expect(normalizeSpamScore(SPAM_SCORE_MAX * 10)).toBe(1);
		});
	});
});
