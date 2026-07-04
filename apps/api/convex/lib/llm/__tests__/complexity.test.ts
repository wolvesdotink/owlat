import { describe, it, expect } from 'vitest';
import {
	scoreComplexity,
	isTrivialUserText,
	COMPLEXITY_DOWNGRADE_THRESHOLD,
	isTrivialClassifiedMessage,
	TRIVIAL_CLASSIFICATION_CONFIDENCE,
} from '../complexity';

describe('scoreComplexity', () => {
	it('scores trivial acknowledgements at/below the downgrade threshold', () => {
		for (const t of ['thanks!', 'ok got it', 'sounds good', 'yes', 'will do', '']) {
			expect(scoreComplexity(t)).toBeLessThanOrEqual(COMPLEXITY_DOWNGRADE_THRESHOLD);
		}
	});

	it('scores code / structured payloads as complex', () => {
		expect(scoreComplexity('Write a function to dedupe this list: ```const x = [1,2,2]```')).toBeGreaterThan(
			COMPLEXITY_DOWNGRADE_THRESHOLD,
		);
		expect(scoreComplexity('SELECT * FROM contacts WHERE created_at > now()')).toBeGreaterThan(
			COMPLEXITY_DOWNGRADE_THRESHOLD,
		);
	});

	it('scores long, multi-part analytical asks as complex', () => {
		const q =
			'Compare our Q1 and Q2 churn, explain why it changed, and also outline a step by step plan to reduce it next quarter.';
		expect(scoreComplexity(q)).toBeGreaterThan(COMPLEXITY_DOWNGRADE_THRESHOLD);
	});

	it('is bounded to [0, 1]', () => {
		expect(scoreComplexity('x'.repeat(5000))).toBeLessThanOrEqual(1);
		expect(scoreComplexity('')).toBe(0);
	});
});

describe('isTrivialUserText', () => {
	it('flags trivial text and spares complex text', () => {
		expect(isTrivialUserText('thanks, got it')).toBe(true);
		expect(isTrivialUserText('Explain why our deliverability dropped and how to analyze the bounce logs')).toBe(false);
	});
});

describe('isTrivialClassifiedMessage', () => {
	const trivial = { category: 'other', intent: 'praise', priority: 'low', confidence: 0.95 };

	it('downgrades a high-confidence, low-stakes, formulaic-intent message', () => {
		expect(isTrivialClassifiedMessage(trivial)).toBe(true);
		expect(isTrivialClassifiedMessage({ ...trivial, intent: 'informational' })).toBe(true);
		expect(isTrivialClassifiedMessage({ ...trivial, intent: 'unsubscribe' })).toBe(true);
	});

	it('keeps the capable tier for substantive intents', () => {
		for (const intent of ['question', 'request', 'complaint', 'urgent']) {
			expect(isTrivialClassifiedMessage({ ...trivial, intent })).toBe(false);
		}
	});

	it('never downgrades a high / critical priority message', () => {
		expect(isTrivialClassifiedMessage({ ...trivial, priority: 'high' })).toBe(false);
		expect(isTrivialClassifiedMessage({ ...trivial, priority: 'critical' })).toBe(false);
	});

	it('never downgrades a low-confidence classification', () => {
		expect(
			isTrivialClassifiedMessage({ ...trivial, confidence: TRIVIAL_CLASSIFICATION_CONFIDENCE - 0.01 }),
		).toBe(false);
	});

	it('reads only the trusted signals — the (untrusted) email body is not an input', () => {
		// The function's signature carries no email text: a crafted body that
		// "looks trivial" cannot flip a substantive classification to the fast
		// tier, and one that "looks complex" cannot force a trivial one to stay
		// capable. Triviality is fully determined by the sanitized signals.
		expect(isTrivialClassifiedMessage({ ...trivial, intent: 'question' })).toBe(false);
		expect(isTrivialClassifiedMessage(trivial)).toBe(true);
	});
});
