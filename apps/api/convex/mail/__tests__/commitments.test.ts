/**
 * Pure-helper coverage for the bidirectional commitment tracker
 * (mail/commitments.ts): the deterministic outbound-commitment gate that bounds
 * the LLM fan-out, the ISO-deadline → timestamp parser, and the description
 * clamp.
 */
import { describe, it, expect } from 'vitest';
import {
	looksLikeOutboundCommitment,
	shouldExtractOutboundCommitment,
	dueHintToTimestamp,
	clampDescription,
} from '../commitments';

describe('looksLikeOutboundCommitment', () => {
	it('flags first-person promises', () => {
		expect(looksLikeOutboundCommitment("I'll send the report Friday")).toBe(true);
		expect(looksLikeOutboundCommitment('I will get back to you tomorrow')).toBe(true);
		expect(looksLikeOutboundCommitment("we'll circle back next week")).toBe(true);
		expect(looksLikeOutboundCommitment('Let me get you the numbers')).toBe(true);
		expect(looksLikeOutboundCommitment('I can send the invoice by Monday')).toBe(true);
	});

	it('ignores mail that makes no promise', () => {
		expect(looksLikeOutboundCommitment('Thanks, sounds good!')).toBe(false);
		expect(looksLikeOutboundCommitment('Please let me know your thoughts.')).toBe(false);
	});
});

describe('shouldExtractOutboundCommitment (bounds the LLM fan-out)', () => {
	const base = {
		fromAddress: 'me@example.com',
		toAddresses: ['alice@example.com'],
		hasListUnsubscribe: false,
		bodyText: "I'll send it Friday",
	};

	it('extracts a 1:1 sent promise', () => {
		expect(shouldExtractOutboundCommitment(base)).toBe(true);
	});

	it('skips bulk / list mail', () => {
		expect(shouldExtractOutboundCommitment({ ...base, hasListUnsubscribe: true })).toBe(false);
	});

	it('skips no-reply / automated senders', () => {
		expect(
			shouldExtractOutboundCommitment({ ...base, fromAddress: 'no-reply@example.com' })
		).toBe(false);
	});

	it('skips mass sends (over the recipient cap)', () => {
		expect(
			shouldExtractOutboundCommitment({
				...base,
				toAddresses: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'],
			})
		).toBe(false);
	});

	it('skips when the body makes no promise even for a 1:1 reply', () => {
		expect(shouldExtractOutboundCommitment({ ...base, bodyText: 'thanks!' })).toBe(false);
	});

	it('skips when there are no recipients', () => {
		expect(shouldExtractOutboundCommitment({ ...base, toAddresses: [] })).toBe(false);
	});
});

describe('dueHintToTimestamp', () => {
	it('parses an ISO date to end-of-day UTC', () => {
		const ts = dueHintToTimestamp('2026-07-10');
		expect(ts).toBe(Date.parse('2026-07-10T23:59:59.999Z'));
	});

	it('returns undefined for fuzzy / empty / non-ISO hints', () => {
		expect(dueHintToTimestamp('by Friday')).toBeUndefined();
		expect(dueHintToTimestamp(null)).toBeUndefined();
		expect(dueHintToTimestamp(undefined)).toBeUndefined();
		expect(dueHintToTimestamp('')).toBeUndefined();
	});
});

describe('clampDescription', () => {
	it('trims + caps to 200 chars', () => {
		expect(clampDescription('  hello  ')).toBe('hello');
		expect(clampDescription('x'.repeat(300))?.length).toBe(200);
	});
	it('returns undefined for empty', () => {
		expect(clampDescription('   ')).toBeUndefined();
		expect(clampDescription(null)).toBeUndefined();
	});
});
