/**
 * The CONFORMANCE suite: every registered question set, through both adapters,
 * asserting they answer the same way.
 *
 * This is the promise the whole plane rests on — any adapter answers any
 * question set, so reverting the vendor is a dropdown rather than a revert, and
 * an install with no key runs the same code paths the one with a key runs. Six
 * per-module suites cannot show that: each of them exercises one adapter, and a
 * divergence lives exactly in the gap between them. A Score's probability keys
 * are where that gap first opened — the language-backed adapter keys them
 * `'1'..'N'` and a vendor legend keyed by its own words would not have — so the
 * key space is asserted here across both adapters, while the codec's refusal of
 * any other legend keying is pinned next door in `decisionProviders/
 * __tests__/wire.test.ts`.
 *
 * What is asserted, per set and per question: the same answer KEYS, the same
 * `kind` per key, the same value DOMAIN, and the same probability KEY SPACE.
 * What is allowed to differ is exactly one thing — `calibrated` — because the
 * language-backed adapter reports one label and cannot produce a distribution
 * behind it.
 *
 * No network: the native adapter runs against a synthesized wire body and the
 * language-backed one against a stubbed `runLlmObject`. Both stubs are built
 * FROM the question set rather than hand-written per case, so a set added to the
 * catalog is covered the moment it is registered — and a set that is never
 * registered is never covered, which is the rule stated as a test below.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	DECISION_PROVIDER_KINDS,
	type DecisionProviderKind,
	type DecisionResult,
} from '../../decisionProviders/types';
import { registeredQuestionSets, isRegisteredQuestionSet } from '../catalog';
import { choice, noul, score, type DecisionQuestion, type QuestionSet } from '../questions';
import type { DecisionAnswer } from '../questions';
import { llmDecisionAdapter } from '../../decisionProviders/llm';
import { typesafeDecisionAdapter } from '../../decisionProviders/typesafe';
import { PINNED_DECISION_MODEL } from '../../decisionProviders/typesafe';

// Only `runLlmObject` is replaced; `isRetriableLlmError` and `errorStatus` stay
// real, because the native adapter classifies its failures through them.
const language = vi.hoisted(() => ({ runLlmObject: vi.fn() }));
vi.mock('../../llm/dispatch', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../llm/dispatch')>()),
	runLlmObject: language.runLlmObject,
}));

const STATE = 'Subject: the invoice is late, and we would like to know when to expect it.';

/** The first option / first level / a mid probability — one deterministic answer per type. */
function nativeAnswer(question: DecisionQuestion): Record<string, unknown> {
	switch (question.type) {
		case 'noul':
			return { type: 'noul', noul: 0.73 };
		case 'choice': {
			const options = Object.keys(question.criteria);
			const share = Number((1 / options.length).toFixed(4));
			return {
				type: 'choice',
				choice: options[0],
				probabilities: Object.fromEntries(options.map((option) => [option, share])),
				confidence: 0.8,
			};
		}
		case 'score': {
			const levels = question.criteria;
			const share = Number((1 / levels.length).toFixed(4));
			return {
				type: 'score',
				score: 0,
				legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
				probabilities: Object.fromEntries(levels.map((_, index) => [String(index), share])),
				confidence: 0.8,
			};
		}
	}
}

/** The same answers in the shape structured output produces on the language plane. */
function languageAnswer(question: DecisionQuestion): unknown {
	switch (question.type) {
		case 'noul':
			return 0.73;
		case 'choice':
			return Object.keys(question.criteria)[0];
		case 'score':
			return 1;
	}
}

function mapValues<T>(questions: QuestionSet, map: (question: DecisionQuestion) => T) {
	return Object.fromEntries(
		Object.entries(questions).map(([id, question]) => [id, map(question as DecisionQuestion)])
	);
}

async function askNative(questions: QuestionSet) {
	const body = JSON.stringify({
		model: PINNED_DECISION_MODEL,
		answers: mapValues(questions, nativeAnswer),
		usage: { input_tokens: 42, output_tokens: 3 },
	});
	return await typesafeDecisionAdapter.ask(
		{
			apiKey: 'conformance-fixture-key',
			fetchImpl: async () =>
				new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
		},
		{ state: STATE, questions }
	);
}

async function askLanguage(questions: QuestionSet) {
	language.runLlmObject.mockResolvedValueOnce({
		object: mapValues(questions, languageAnswer),
		tokenUsage: { promptTokens: 900, completionTokens: 12, totalTokens: 912 },
		modelUsed: 'gpt-4.1-mini',
	});
	return await llmDecisionAdapter.ask({}, {
		state: STATE,
		questions,
		model: 'gpt-4.1-mini',
	} as never);
}

// Exhaustive: registering a provider also requires a transport fixture here.
const conformanceAdapters = {
	typesafe: askNative,
	llm: askLanguage,
} satisfies Record<DecisionProviderKind, (questions: QuestionSet) => Promise<DecisionResult>>;

async function askAll(questions: QuestionSet): Promise<DecisionResult[]> {
	const answers: DecisionResult[] = [];
	for (const kind of DECISION_PROVIDER_KINDS)
		answers.push(await conformanceAdapters[kind](questions));
	return answers;
}

/** The shape a caller may rely on, whichever adapter answered. */
function contractOf(answer: DecisionAnswer) {
	return {
		kind: answer.kind,
		probabilityKeys: answer.kind === 'noul' ? null : Object.keys(answer.probabilities).sort(),
		hasConfidence: 'confidence' in answer,
	};
}

/**
 * One set covering all three answer types.
 *
 * Deliberately NOT registered: the catalog holds what the product actually
 * asks, and P1 ships one probe. Inventing entries so the suite looks fuller
 * would put question sets with no caller in the catalog, which is the thing the
 * registry exists to make impossible. So the catalog is swept for what is real,
 * and this fixture covers the types nothing asks yet — including the Score
 * whose legend keying is where the two adapters last disagreed.
 */
const TYPE_COVERAGE_QUESTIONS = {
	needsReply: noul('Does this message need a reply?'),
	category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
	urgency: score('How urgent is it?', ['Not urgent', 'This week', 'Immediately']),
};

const catalog = registeredQuestionSets();

describe('the catalog', () => {
	it('has something in it, and every set asks at least one question', () => {
		expect(catalog.length).toBeGreaterThan(0);
		for (const entry of catalog) {
			expect(Object.keys(entry.questions).length).toBeGreaterThan(0);
			expect(entry.purpose.trim().length).toBeGreaterThan(0);
		}
	});

	it('does not recognise a set that was built at a call site', () => {
		// The rule this states: a set that is not in the catalog is a set no
		// conformance run ever put through the language-backed adapter, and the day
		// the vendor is unreachable is the day that is discovered.
		expect(isRegisteredQuestionSet({ inline: noul('Was this ever measured?') })).toBe(false);
		for (const entry of catalog) {
			expect(isRegisteredQuestionSet(entry.questions)).toBe(true);
		}
	});
});

function conformanceSuite(questions: QuestionSet): void {
	it('answers the same keys, kinds and probability spaces under both adapters', async () => {
		const [native, ...others] = await askAll(questions);
		if (!native) throw new Error('No decision adapters registered');

		const ids = Object.keys(questions);
		expect(Object.keys(native.answers)).toEqual(ids);
		for (const language of others) {
			expect(Object.keys(language.answers)).toEqual(ids);

			for (const id of ids) {
				const nativeAnswerFor = native.answers[id] as DecisionAnswer;
				const languageAnswerFor = language.answers[id] as DecisionAnswer;
				expect(contractOf(languageAnswerFor)).toEqual(contractOf(nativeAnswerFor));
				expect(nativeAnswerFor.kind).toBe(questions[id]?.type);
			}
		}
	});

	it('answers inside the domain the question defined, under both adapters', async () => {
		const answered = await askAll(questions);

		for (const result of answered) {
			for (const [id, question] of Object.entries(questions)) {
				const answer = result.answers[id] as DecisionAnswer;
				if (answer.kind === 'noul') {
					expect(answer.probability).toBeGreaterThanOrEqual(0);
					expect(answer.probability).toBeLessThanOrEqual(1);
					continue;
				}
				if (answer.kind === 'choice' && question.type === 'choice') {
					expect(Object.keys(question.criteria)).toContain(answer.value);
					continue;
				}
				if (answer.kind === 'score' && question.type === 'score') {
					expect(answer.levels).toEqual([...question.criteria]);
					expect(Object.keys(answer.probabilities)).toEqual(
						question.criteria.map((_level, index) => String(index + 1))
					);
					expect(answer.value).toBeGreaterThanOrEqual(1);
					expect(answer.value).toBeLessThanOrEqual(question.criteria.length);
				}
			}
		}
	});

	it('differs in exactly one thing: whether the probabilities are calibrated', async () => {
		expect((await askNative(questions)).calibrated).toBe(true);
		expect((await askLanguage(questions)).calibrated).toBe(false);
	});
}

describe.each(catalog.map((entry) => [entry.id, entry.questions] as const))(
	'registered question set %s',
	(_id, questions) => conformanceSuite(questions)
);

describe('all three answer types', () => conformanceSuite(TYPE_COVERAGE_QUESTIONS));
