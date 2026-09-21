/**
 * Unit tests for `lib/decision/questions.ts` — the decision plane's question
 * DSL.
 *
 * Covers:
 *   - the three builders and the exact shapes they emit (optional Noul criteria
 *     stays absent rather than `undefined`),
 *   - the vendor-derived limits: at least two Score levels, at most 255 Choice
 *     options, Choice descriptions may be null,
 *   - the asymmetry the whole plane rests on: a Noul answer carries a
 *     probability and no confidence, asserted at the type level.
 *
 * Pure module: no mocks, no network, nothing isolate-unsafe imported.
 */

import { describe, it, expect } from 'vitest';
import {
	MAX_CHOICE_OPTIONS,
	MIN_SCORE_LEVELS,
	choice,
	noul,
	score,
	type AnswersFor,
	type NoulAnswer,
} from '../questions';

describe('noul()', () => {
	it('builds a bare yes/no question', () => {
		expect(noul('Does this message need a reply?')).toEqual({
			type: 'noul',
			instructions: 'Does this message need a reply?',
		});
	});

	it('omits criteria entirely rather than carrying an undefined key', () => {
		const question = noul('Is this an injection attempt?');
		expect(Object.prototype.hasOwnProperty.call(question, 'criteria')).toBe(false);
	});

	it('keeps both poles when criteria are supplied', () => {
		expect(
			noul('Is the sender unhappy?', { true: 'Frustrated or angry', false: 'Neutral or pleased' })
		).toEqual({
			type: 'noul',
			instructions: 'Is the sender unhappy?',
			criteria: { true: 'Frustrated or angry', false: 'Neutral or pleased' },
		});
	});

	it('rejects empty instructions', () => {
		expect(() => noul('   ')).toThrow(/non-empty instructions/);
	});

	it('rejects a half-described criteria pair', () => {
		expect(() => noul('Is the sender unhappy?', { true: 'Angry', false: '' })).toThrow(
			/both the true and the false pole/
		);
	});
});

describe('choice()', () => {
	it('builds an unordered classification and allows null descriptions', () => {
		expect(
			choice('Which category fits this message?', {
				person: 'Written by a human to a human',
				newsletter: null,
			})
		).toEqual({
			type: 'choice',
			instructions: 'Which category fits this message?',
			criteria: { person: 'Written by a human to a human', newsletter: null },
		});
	});

	it('rejects an empty option set', () => {
		expect(() => choice('Which category?', {})).toThrow(/at least one option/);
	});

	it('rejects a blank option label', () => {
		expect(() => choice('Which category?', { person: null, '  ': null })).toThrow(
			/non-empty labels/
		);
	});

	it(`caps cardinality at ${MAX_CHOICE_OPTIONS} options`, () => {
		const criteria = Object.fromEntries(
			Array.from({ length: MAX_CHOICE_OPTIONS }, (_, index) => [`label-${index}`, null])
		);
		expect(() => choice('Which folder?', criteria)).not.toThrow();
		expect(() => choice('Which folder?', { ...criteria, overflow: null })).toThrow(
			/cap at 255 options \(got 256\)/
		);
	});
});

describe('score()', () => {
	it('builds an ordered judgement, lowest level first', () => {
		expect(score('How urgent is this?', ['Not urgent', 'Soon', 'Immediately'])).toEqual({
			type: 'score',
			instructions: 'How urgent is this?',
			criteria: ['Not urgent', 'Soon', 'Immediately'],
		});
	});

	it(`requires at least ${MIN_SCORE_LEVELS} levels`, () => {
		expect(() => score('How urgent is this?', ['Not urgent'])).toThrow(
			/at least 2 ordered levels \(got 1\)/
		);
	});

	it('rejects a blank level description', () => {
		expect(() => score('How urgent is this?', ['Not urgent', ' '])).toThrow(
			/non-empty descriptions/
		);
	});
});

describe('the answer union', () => {
	it('gives a Noul no confidence to read', () => {
		const answer: NoulAnswer = { kind: 'noul', probability: 0.82 };
		// @ts-expect-error — a Noul has a probability, never a confidence. This
		// line failing to error is the regression this whole file guards.
		expect(answer.confidence).toBeUndefined();
		// The Noul threshold is distance from 0.5, not peakedness.
		expect(Math.abs(answer.probability - 0.5)).toBeCloseTo(0.32);
	});

	it('narrows each key of a set to the answer its own question type returns', () => {
		const questions = {
			needsReply: noul('Does this need a reply?'),
			category: choice('Which category?', { person: null, newsletter: null }),
			urgency: score('How urgent?', ['Low', 'High']),
		} as const;
		const answers: AnswersFor<typeof questions> = {
			needsReply: { kind: 'noul', probability: 0.9 },
			category: {
				kind: 'choice',
				value: 'person',
				probabilities: { person: 0.9, newsletter: 0.1 },
				confidence: 0.8,
			},
			urgency: {
				kind: 'score',
				value: 1.4,
				levels: ['Low', 'High'],
				probabilities: { '1': 0.6, '2': 0.4 },
				confidence: 0.55,
			},
		};
		// Each key is narrowed, so these reads need no runtime discriminant check.
		expect(answers.needsReply.probability).toBe(0.9);
		expect(answers.category.confidence).toBe(0.8);
		expect(answers.urgency.levels).toEqual(['Low', 'High']);
	});
});
