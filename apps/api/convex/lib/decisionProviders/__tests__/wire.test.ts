/**
 * Unit tests for `lib/decisionProviders/wire.ts` — the one place the vendor's
 * request/response vocabulary is spoken.
 *
 * Covers:
 *   - encoding each question type, including the optional Noul criteria and the
 *     defensive copies (a caller's frozen literal must not reach the socket by
 *     reference),
 *   - decoding the three answer shapes, including the Noul/confidence asymmetry
 *     and an array-shaped Score legend,
 *   - the hard errors the plan mandates: a missing requested key, an extra key,
 *     a mismatched type, a Choice value outside the criteria, a partial or
 *     foreign distribution, a score off its own legend,
 *   - `input_tokens`/`output_tokens` → `TokenUsage`, strictly.
 *
 * No network and no mocks — the codec is pure, which is the point of splitting
 * it out of the adapter.
 */

import { describe, it, expect } from 'vitest';
import { choice, noul, score } from '../../decision/questions';
import {
	DecisionWireError,
	decodeAnswers,
	decodeResponse,
	decodeUsage,
	encodeQuestions,
} from '../wire';

const questions = {
	needsReply: noul('Does this message need a reply?'),
	category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
	urgency: score('How urgent is it?', ['Not urgent', 'This week', 'Immediately']),
};

const answers = {
	needsReply: { type: 'noul', noul: 0.91 },
	category: {
		type: 'choice',
		choice: 'person',
		probabilities: { person: 0.88, newsletter: 0.12 },
		confidence: 0.76,
	},
	urgency: {
		type: 'score',
		score: 1.4,
		legend: { '0': 'Not urgent', '1': 'This week', '2': 'Immediately' },
		probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
		confidence: 0.61,
	},
};

describe('encodeQuestions()', () => {
	it('renders each question type into the vendor shape', () => {
		expect(encodeQuestions(questions)).toEqual({
			needsReply: { type: 'noul', instructions: 'Does this message need a reply?' },
			category: {
				type: 'choice',
				instructions: 'Which category fits?',
				criteria: { person: 'A human wrote it', newsletter: null },
			},
			urgency: {
				type: 'score',
				instructions: 'How urgent is it?',
				criteria: ['Not urgent', 'This week', 'Immediately'],
			},
		});
	});

	it('carries Noul criteria only when they were supplied', () => {
		const encoded = encodeQuestions({
			plain: noul('Is it spam?'),
			described: noul('Is the sender unhappy?', { true: 'Angry', false: 'Content' }),
		});
		expect(Object.prototype.hasOwnProperty.call(encoded['plain'] ?? {}, 'criteria')).toBe(false);
		expect(encoded['described']).toMatchObject({ criteria: { true: 'Angry', false: 'Content' } });
	});

	it('copies criteria rather than aliasing the question set it was given', () => {
		const encoded = encodeQuestions(questions);
		expect(encoded['category']).toMatchObject({ criteria: expect.any(Object) });
		expect((encoded['category'] as { criteria: object }).criteria).not.toBe(
			questions.category.criteria
		);
		expect((encoded['urgency'] as { criteria: string[] }).criteria).not.toBe(
			questions.urgency.criteria
		);
	});

	it('refuses an empty question set rather than billing an empty round trip', () => {
		expect(() => encodeQuestions({})).toThrow(DecisionWireError);
		expect(() => encodeQuestions({})).toThrow(/at least one question/);
	});
});

describe('decodeAnswers()', () => {
	it.each([0, 1, 2])('maps vendor level %i and its probability key together', (level) => {
		const probabilities = Object.fromEntries(
			[0, 1, 2].map((i) => [String(i), i === level ? 1 : 0])
		);
		const decoded = decodeAnswers(
			{ urgency: questions.urgency },
			{
				urgency: { ...answers.urgency, score: level, probabilities },
			}
		);
		expect(decoded['urgency']).toMatchObject({
			value: level + 1,
			probabilities: { [String(level + 1)]: 1 },
		});
	});

	it('normalizes the documented TypeSafe score example to the public 1-based scale', () => {
		// https://docs.typesafe.ai/api — Score answer. Keep this vendor fixture
		// independent of our encoder and the synthesized conformance responses.
		const decoded = decodeResponse(
			{
				frustration: score('How frustrated is the customer?', ['Calm', 'Frustrated', 'Very angry']),
			},
			{
				model: 'jev-1.13.0',
				answers: {
					frustration: {
						type: 'score',
						score: 1.6,
						legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
						probabilities: { '0': 0.05, '1': 0.3, '2': 0.65 },
						confidence: 0.78,
					},
				},
				usage: { input_tokens: 312, output_tokens: 48 },
			}
		);
		expect(decoded.answers['frustration']).toEqual({
			kind: 'score',
			value: 2.6,
			levels: ['Calm', 'Frustrated', 'Very angry'],
			probabilities: { '1': 0.05, '2': 0.3, '3': 0.65 },
			confidence: 0.78,
		});
	});

	it('maps the three wire shapes onto the discriminated answer union', () => {
		expect(decodeAnswers(questions, answers)).toEqual({
			needsReply: { kind: 'noul', probability: 0.91 },
			category: {
				kind: 'choice',
				value: 'person',
				probabilities: { person: 0.88, newsletter: 0.12 },
				confidence: 0.76,
			},
			urgency: {
				kind: 'score',
				value: 2.4,
				levels: ['Not urgent', 'This week', 'Immediately'],
				probabilities: { '1': 0.1, '2': 0.5, '3': 0.4 },
				confidence: 0.61,
			},
		});
	});

	it('gives a Noul no confidence even when the wire volunteers one', () => {
		const decoded = decodeAnswers(
			{ needsReply: questions.needsReply },
			{ needsReply: { type: 'noul', noul: 0.4, confidence: 0.9 } }
		);
		expect(decoded['needsReply']).toEqual({ kind: 'noul', probability: 0.4 });
	});

	it('reads an ordered array legend as 1-based level keys', () => {
		const decoded = decodeAnswers(
			{ urgency: questions.urgency },
			{
				urgency: {
					type: 'score',
					score: 0,
					legend: ['Not urgent', 'This week', 'Immediately'],
					probabilities: { '0': 0.7, '1': 0.2, '2': 0.1 },
					confidence: 0.5,
				},
			}
		);
		expect(decoded['urgency']).toMatchObject({ kind: 'score', value: 1 });
	});

	it('names the question that came back missing', () => {
		const { needsReply: _dropped, ...partial } = answers;
		expect(() => decodeAnswers(questions, partial)).toThrow(/no answer for question 'needsReply'/);
	});

	it('rejects an answer nobody asked for', () => {
		expect(() =>
			decodeAnswers(questions, { ...answers, sentiment: { type: 'noul', noul: 0.5 } })
		).toThrow(/answered 'sentiment', which was not asked/);
	});

	it('rejects an answer of the wrong type', () => {
		expect(() =>
			decodeAnswers({ needsReply: questions.needsReply }, { needsReply: answers.category })
		).toThrow(/came back as 'choice', but 'noul' was asked/);
	});

	it('rejects a Choice value outside the criteria instead of coercing it', () => {
		expect(() =>
			decodeAnswers(
				{ category: questions.category },
				{ category: { ...answers.category, choice: 'receipt' } }
			)
		).toThrow(/chose 'receipt', which is not one of the 2 options/);
	});

	it('truncates an oversized foreign value before it reaches a log line', () => {
		const shouted = 'x'.repeat(500);
		expect(() =>
			decodeAnswers(
				{ category: questions.category },
				{ category: { ...answers.category, choice: shouted } }
			)
		).toThrow(/x{80}…/);
	});

	it('rejects a probability over an option that was never offered', () => {
		expect(() =>
			decodeAnswers(
				{ category: questions.category },
				{
					category: {
						...answers.category,
						probabilities: { person: 0.5, newsletter: 0.4, receipt: 0.1 },
					},
				}
			)
		).toThrow(/probability for 'receipt', which was not offered/);
	});

	it('rejects a partial distribution — it cannot be thresholded', () => {
		expect(() =>
			decodeAnswers(
				{ category: questions.category },
				{ category: { ...answers.category, probabilities: { person: 1 } } }
			)
		).toThrow(/no probability for 'newsletter'/);
	});

	it('rejects a probability or confidence outside [0, 1]', () => {
		expect(() =>
			decodeAnswers(
				{ needsReply: questions.needsReply },
				{ needsReply: { type: 'noul', noul: 1.2 } }
			)
		).toThrow(/noul is not a number in \[0, 1\]/);
		expect(() =>
			decodeAnswers(
				{ category: questions.category },
				{ category: { ...answers.category, confidence: null } }
			)
		).toThrow(/confidence is not a number in \[0, 1\]/);
	});

	it('rejects a legend that does not match the levels that were sent', () => {
		expect(() =>
			decodeAnswers(
				{ urgency: questions.urgency },
				{ urgency: { ...answers.urgency, legend: { '1': 'Low', '2': 'High' } } }
			)
		).toThrow(/scored against 2 levels, but 3 were sent/);
	});

	it('refuses a legend keyed any way but by the levels we numbered', () => {
		// The failure this closes: a legend of three words is the right SIZE, so a
		// size-only check accepts it — and then the range test below has no numbers
		// to compare against and quietly stops running, which is how `score: 9`
		// against a three-level scale arrives as a verdict. It also hands the two
		// adapters different probability key spaces for the same question.
		expect(() =>
			decodeAnswers(
				{ urgency: questions.urgency },
				{
					urgency: {
						...answers.urgency,
						legend: { low: 'Not urgent', mid: 'This week', high: 'Immediately' },
						probabilities: { low: 0.7, mid: 0.2, high: 0.1 },
					},
				}
			)
		).toThrow(/legend key 'low', but the levels that were sent are numbered 0 to 2/);
	});

	it('refuses a legend numbered outside the scale, or twice over', () => {
		expect(() =>
			decodeAnswers(
				{ urgency: questions.urgency },
				{
					urgency: {
						...answers.urgency,
						legend: { '1': 'Not urgent', '2': 'This week', '3': 'Immediately' },
						probabilities: { '1': 0.7, '2': 0.2, '3': 0.1 },
					},
				}
			)
		).toThrow(/legend key '3'/);
	});

	it('keeps the range check alive for a record legend, whatever its order', () => {
		// Same three levels, listed high-first. The keys are still the ordinals, so
		// the scale is still 0–2 and a 9 is still off it.
		const highFirst = {
			urgency: {
				...answers.urgency,
				legend: { '2': 'Immediately', '1': 'This week', '0': 'Not urgent' },
			},
		};
		expect(decodeAnswers({ urgency: questions.urgency }, highFirst)).toMatchObject({
			urgency: { kind: 'score', probabilities: { '1': 0.1, '2': 0.5, '3': 0.4 } },
		});
		expect(() =>
			decodeAnswers({ urgency: questions.urgency }, { urgency: { ...highFirst.urgency, score: 9 } })
		).toThrow(/scored 9, outside its 0–2 legend/);
	});

	it('accepts a score between levels but not one off the scale', () => {
		expect(
			decodeAnswers({ urgency: questions.urgency }, { urgency: { ...answers.urgency, score: 1.5 } })
		).toMatchObject({ urgency: { value: 2.5 } });
		expect(() =>
			decodeAnswers({ urgency: questions.urgency }, { urgency: { ...answers.urgency, score: 4 } })
		).toThrow(/scored 4, outside its 0–2 legend/);
	});

	it('rejects a non-object answers member', () => {
		expect(() => decodeAnswers(questions, 'nope')).toThrow(/answers is not an object/);
		expect(() => decodeAnswers(questions, [answers])).toThrow(/answers is not an object/);
	});
});

describe('decodeUsage()', () => {
	it('maps the vendor counters onto TokenUsage and totals them', () => {
		expect(decodeUsage({ input_tokens: 10_500, output_tokens: 42 })).toEqual({
			promptTokens: 10_500,
			completionTokens: 42,
			totalTokens: 10_542,
		});
	});

	it('refuses to read a missing counter as zero — free is not the same as unknown', () => {
		expect(() => decodeUsage({ output_tokens: 42 })).toThrow(
			/usage.input_tokens is not a token count/
		);
		expect(() => decodeUsage({ input_tokens: -1, output_tokens: 0 })).toThrow(
			/usage.input_tokens is not a token count/
		);
		expect(() => decodeUsage(undefined)).toThrow(/usage is not an object/);
	});
});

describe('decodeResponse()', () => {
	it('does not carry invalid usage into a failed attempt record', () => {
		try {
			decodeResponse(questions, {
				model: 'jev-1.13.0',
				answers: {},
				usage: { input_tokens: -1, output_tokens: 2 },
			});
			expect.fail('Expected a codec refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(DecisionWireError);
			expect(error).toMatchObject({ usage: undefined, modelUsed: undefined });
		}
	});

	it('decodes answers, usage and the model the provider reported', () => {
		expect(
			decodeResponse(questions, {
				model: 'jev-1.13.0',
				answers,
				usage: { input_tokens: 2_400, output_tokens: 120 },
			})
		).toEqual({
			modelUsed: 'jev-1.13.0',
			answers: decodeAnswers(questions, answers),
			usage: { promptTokens: 2_400, completionTokens: 120, totalTokens: 2_520 },
		});
	});

	it('requires a reported model id, so a silent reroute cannot pass unseen', () => {
		expect(() =>
			decodeResponse(questions, { answers, usage: { input_tokens: 1, output_tokens: 0 } })
		).toThrow(/no model id reported/);
	});

	it('rejects a non-object body', () => {
		expect(() => decodeResponse(questions, null)).toThrow(DecisionWireError);
		expect(() => decodeResponse(questions, null)).toThrow(/body is not an object/);
	});
});
