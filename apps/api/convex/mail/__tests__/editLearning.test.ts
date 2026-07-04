/**
 * Pure-logic tests for the edit-learning flywheel (mail/editLearning):
 *
 *   - normalizedEditDistance / pushEditDistanceSample / medianEditDistance:
 *     the north-star metric is recorded and bounded
 *   - classifyEdits: high-signal structural deltas are detected; noise is not
 *   - mergeAdjustment: a recurring delta promotes only at the threshold; a
 *     one-off never promotes → promotedDirectives stays empty
 *   - buildLayeredGuidance: standing instructions merge in; a per-contact
 *     override only appears when THAT contact's directives are passed
 */

import { describe, it, expect } from 'vitest';
import {
	normalizedEditDistance,
	pushEditDistanceSample,
	medianEditDistance,
	classifyEdits,
	mergeAdjustment,
	promotedDirectives,
	buildLayeredGuidance,
	isContactLevelKind,
	isVoiceLevelKind,
	DELTA_DIRECTIVE,
	EDIT_RECURRENCE_THRESHOLD,
	EDIT_DISTANCE_WINDOW,
	type EditAdjustment,
} from '../editLearning';

describe('normalizedEditDistance', () => {
	it('is 0 for identical bodies and 1 for fully disjoint ones', () => {
		expect(normalizedEditDistance('Hello there', 'Hello there')).toBe(0);
		expect(normalizedEditDistance('aaaa', 'bbbb')).toBe(1);
	});

	it('is a fraction in (0,1) for a partial edit', () => {
		const d = normalizedEditDistance('Hi Sam, thanks!', 'Hi Sam, thanks');
		expect(d).toBeGreaterThan(0);
		expect(d).toBeLessThan(1);
	});

	it('ignores HTML markup when diffing', () => {
		expect(normalizedEditDistance('<p>Hello there</p>', 'Hello there')).toBe(0);
	});
});

describe('edit-distance metric window', () => {
	it('records samples and keeps a bounded rolling window', () => {
		let samples: number[] = [];
		for (let i = 0; i < EDIT_DISTANCE_WINDOW + 10; i++) {
			samples = pushEditDistanceSample(samples, i % 2 === 0 ? 0.2 : 0.4);
		}
		expect(samples.length).toBe(EDIT_DISTANCE_WINDOW);
	});

	it('computes the median (null when empty)', () => {
		expect(medianEditDistance([])).toBeNull();
		expect(medianEditDistance([0.5])).toBe(0.5);
		expect(medianEditDistance([0.2, 0.8])).toBeCloseTo(0.5);
		expect(medianEditDistance([0.1, 0.2, 0.9])).toBeCloseTo(0.2);
	});
});

describe('classifyEdits', () => {
	it('detects a removed greeting', () => {
		const baseline = 'Hi Dana,\n\nThe report is attached.\n\nThanks';
		const sent = 'The report is attached.\n\nThanks';
		expect(classifyEdits(baseline, sent)).toContain('removed_greeting');
	});

	it('detects shortening', () => {
		const baseline =
			'Thank you so much for reaching out about this, I really appreciate ' +
			'the detailed context you provided and I will look into it right away.';
		const sent = 'Thanks, looking into it.';
		expect(classifyEdits(baseline, sent)).toContain('shortened');
	});

	it('detects a removed exclamation mark', () => {
		expect(classifyEdits('Great news!', 'Great news')).toContain('removed_exclamation');
	});

	it('detects a language switch (recipient-specific)', () => {
		const kinds = classifyEdits('Thanks, talk soon', 'Спасибо, до скорого свидания');
		expect(kinds).toContain('language_switch');
		expect(isContactLevelKind('language_switch')).toBe(true);
	});

	it('returns nothing for a no-op edit', () => {
		expect(classifyEdits('The report is attached.', 'The report is attached.')).toEqual([]);
	});

	it('routes structural habits to the voice level', () => {
		expect(isVoiceLevelKind('removed_greeting')).toBe(true);
		expect(isVoiceLevelKind('language_switch')).toBe(false);
	});
});

describe('mergeAdjustment (recurrence threshold)', () => {
	const now = 1_700_000_000_000;

	it('does NOT promote a one-off edit', () => {
		const { list, justPromoted } = mergeAdjustment([], 'removed_greeting', now);
		expect(list[0]?.observations).toBe(1);
		expect(list[0]?.promoted).toBe(false);
		expect(justPromoted).toBe(false);
		expect(promotedDirectives(list)).toEqual([]);
	});

	it('promotes a delta only after it recurs THRESHOLD times', () => {
		let list: EditAdjustment[] = [];
		let promotedAt = 0;
		for (let i = 1; i <= EDIT_RECURRENCE_THRESHOLD; i++) {
			const res = mergeAdjustment(list, 'shortened', now + i);
			list = res.list;
			if (res.justPromoted) promotedAt = i;
		}
		expect(promotedAt).toBe(EDIT_RECURRENCE_THRESHOLD);
		expect(list[0]?.promoted).toBe(true);
		expect(list[0]?.observations).toBe(EDIT_RECURRENCE_THRESHOLD);
		expect(promotedDirectives(list)).toEqual([DELTA_DIRECTIVE.shortened]);
	});

	it('tracks distinct kinds independently', () => {
		let list: EditAdjustment[] = [];
		list = mergeAdjustment(list, 'removed_greeting', now).list;
		list = mergeAdjustment(list, 'removed_signoff', now).list;
		expect(list.length).toBe(2);
		expect(promotedDirectives(list)).toEqual([]);
	});
});

describe('buildLayeredGuidance', () => {
	it('is null when every layer is empty', () => {
		expect(buildLayeredGuidance({})).toBeNull();
	});

	it('merges standing instructions into the prompt above everything else', () => {
		const out = buildLayeredGuidance({
			standingInstructions: ['Never use exclamation marks', 'Sign as Dr.'],
			voiceBlock: 'VOICE BLOCK',
			derivedDirectives: [DELTA_DIRECTIVE.shortened],
		});
		expect(out).not.toBeNull();
		expect(out).toContain('Never use exclamation marks');
		expect(out).toContain('Sign as Dr.');
		// Standing instructions come first (highest priority).
		expect(out!.indexOf('Never use exclamation marks')).toBeLessThan(out!.indexOf('VOICE BLOCK'));
		expect(out!.indexOf('VOICE BLOCK')).toBeLessThan(out!.indexOf(DELTA_DIRECTIVE.shortened));
	});

	it('drops blank standing instructions', () => {
		expect(buildLayeredGuidance({ standingInstructions: ['', '   '] })).toBeNull();
	});

	it('includes the per-contact override only when that contact directives are passed', () => {
		const withContact = buildLayeredGuidance({
			voiceBlock: 'VOICE',
			contactDirectives: [DELTA_DIRECTIVE.language_switch],
		});
		expect(withContact).toContain(DELTA_DIRECTIVE.language_switch);

		// Drafting to a DIFFERENT contact passes no contact directives → the
		// per-contact rule does not leak in.
		const withoutContact = buildLayeredGuidance({ voiceBlock: 'VOICE' });
		expect(withoutContact).not.toContain(DELTA_DIRECTIVE.language_switch);
	});
});
