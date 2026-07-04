/**
 * Unit tests for "Coach my draft" (mail/aiCoach.coachDraft) via its pure exported
 * adapters {@link toCoachSuggestions} + {@link categorizeCoachFlag}.
 *
 * coachDraft REUSES the agent's draft-quality self-check pass on the USER's own
 * text, then maps the flat critique into categorized inline suggestions. These
 * exercise that mapping directly — the network / model is never touched — so a
 * WEAK self-check yields structured suggestions, a CLEAN one yields none, and
 * the fail-soft `null` result yields none. The adapter is pure: it takes a
 * critique and returns notes; it never sees or returns the draft text, so it
 * cannot mutate the user's draft.
 */

import { describe, it, expect } from 'vitest';
import { toCoachSuggestions, categorizeCoachFlag } from '../aiCoach';

describe('categorizeCoachFlag', () => {
	it('buckets a missing-answer flag', () => {
		expect(categorizeCoachFlag('Does not answer the question about the refund')).toBe(
			'missing-answer'
		);
		expect(categorizeCoachFlag('The pricing question is left out')).toBe('missing-answer');
	});

	it('buckets a tone flag', () => {
		expect(categorizeCoachFlag('The tone reads as curt and abrupt')).toBe('tone');
		expect(categorizeCoachFlag('This comes across as dismissive')).toBe('tone');
	});

	it('buckets an ambiguity flag', () => {
		expect(categorizeCoachFlag('The date is ambiguous — could mean two things')).toBe('ambiguity');
		expect(categorizeCoachFlag('"soon" is vague')).toBe('ambiguity');
	});

	it('falls back to clarity for anything unrecognised', () => {
		expect(categorizeCoachFlag('some other issue')).toBe('clarity');
		expect(categorizeCoachFlag('')).toBe('clarity');
	});
});

describe('toCoachSuggestions', () => {
	it('returns NO suggestions for a clean self-check', () => {
		expect(toCoachSuggestions({ score: 0.95, complete: true, grounded: true, flags: [] })).toEqual(
			[]
		);
	});

	it('returns NO suggestions for the fail-soft null result', () => {
		expect(toCoachSuggestions(null)).toEqual([]);
	});

	it('returns structured, categorized suggestions for a weak draft', () => {
		const out = toCoachSuggestions({
			score: 0.3,
			complete: false,
			grounded: true,
			flags: ['The tone is harsh', 'The delivery date is vague'],
		});
		expect(out.length).toBeGreaterThanOrEqual(2);
		const categories = out.map((s) => s.category);
		expect(categories).toContain('tone');
		expect(categories).toContain('ambiguity');
		// `complete: false` surfaces a missing-answer note even without a matching flag.
		expect(categories).toContain('missing-answer');
		// Every suggestion carries a non-empty message.
		expect(out.every((s) => s.message.length > 0)).toBe(true);
	});

	it('surfaces a clarity note when the draft is ungrounded', () => {
		const out = toCoachSuggestions({
			score: 0.5,
			complete: true,
			grounded: false,
			flags: [],
		});
		expect(out.some((s) => s.category === 'clarity')).toBe(true);
	});

	it('dedupes identical flags', () => {
		const out = toCoachSuggestions({
			score: 0.4,
			complete: true,
			grounded: true,
			flags: ['The tone is harsh', 'The tone is harsh', '  the tone is harsh  '],
		});
		expect(out.length).toBe(1);
	});

	it('ignores blank/whitespace flags', () => {
		const out = toCoachSuggestions({
			score: 0.9,
			complete: true,
			grounded: true,
			flags: ['', '   '],
		});
		expect(out).toEqual([]);
	});
});
