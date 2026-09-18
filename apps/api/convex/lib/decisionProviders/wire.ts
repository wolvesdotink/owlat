/**
 * Decision plane — the vendor wire codec.
 *
 * ONE file owns the translation between our question DSL (`lib/decision/
 * questions.ts`) and the TypeSafe request/response shape, exactly as
 * `normalizeUsage` in `lib/llm/dispatch.ts` owns the AI SDK's field-name
 * history. Nothing outside this file spells `noul`, `input_tokens` or `legend`.
 *
 * The request is `{ state, model, questions: { id: { type, instructions,
 * criteria? } } }`; the response is `{ model, answers: { id: { type, noul |
 * choice | score, probabilities?, confidence?, legend? } }, usage:
 * { input_tokens, output_tokens } }`.
 *
 * DECODING IS STRICT AND NEVER REPAIRS. A missing requested key, an unrequested
 * extra key, a type that isn't the one we asked, a Choice value outside the
 * criteria we sent, a probability over an option we never offered or a missing
 * one, a Score legend of the wrong size: all hard errors. Silently repairing
 * any of them would mean our question set and the model disagree about what was
 * asked, and it would corrupt the agreement and calibration statistics that
 * every later phase of the rollout gates on. A Score's levels are the one shape
 * this file normalizes rather than refuses — an array legend is read by position
 * — and even that only onto the ordinal keys the levels were sent as, so both
 * adapters hand a caller the same probability key space. Usage is strict for the
 * same reason the spend ceiling exists: a decision that reports no tokens is a
 * decision that bills as free.
 *
 * Vendor values are echoed into error messages TRUNCATED — a Choice value comes
 * out of a model reading untrusted inbound mail, and error strings reach logs.
 *
 * Pure and isolate-safe: no fetch, no crypto, no SDK. The adapter
 * (`./typesafe.ts`) owns the transport and calls in here for both directions.
 */

import type { TokenUsage } from '../../agent/steps/types';
import type {
	ChoiceQuestion,
	DecisionAnswer,
	DecisionQuestion,
	QuestionSet,
	ScoreQuestion,
} from '../decision/questions';

/** Raised when the response disagrees with the question set that produced it. */
export class DecisionWireError extends Error {
	readonly usage?: TokenUsage;
	readonly modelUsed?: string;

	constructor(message: string, billed?: { usage: TokenUsage; modelUsed: string }) {
		super(message);
		this.name = 'DecisionWireError';
		this.usage = billed?.usage;
		this.modelUsed = billed?.modelUsed;
	}
}

export type WireQuestion =
	| { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
	| { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
	| { type: 'score'; instructions: string; criteria: string[] };

/** The `questions` member of the request body, keyed by our own answer keys. */
export type WireQuestions = Record<string, WireQuestion>;

/** What one decoded response carries beyond the answers themselves. */
export interface DecodedDecisionResponse {
	readonly answers: Record<string, DecisionAnswer>;
	readonly usage: TokenUsage;
	readonly modelUsed: string;
}

const MAX_ECHOED_VALUE_LENGTH = 80;

function echo(value: unknown): string {
	const rendered = typeof value === 'string' ? value : JSON.stringify(value);
	if (rendered === undefined) return String(value);
	return rendered.length > MAX_ECHOED_VALUE_LENGTH
		? `${rendered.slice(0, MAX_ECHOED_VALUE_LENGTH)}…`
		: rendered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Presence, not truthiness — a probability of 0 is an answer, not a missing key. */
function hasKey(record: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

// ─── Encode ────────────────────────────────────────────────────────────────

function encodeQuestion(question: DecisionQuestion): WireQuestion {
	switch (question.type) {
		case 'noul':
			return question.criteria
				? {
						type: 'noul',
						instructions: question.instructions,
						criteria: { ...question.criteria },
					}
				: { type: 'noul', instructions: question.instructions };
		case 'choice':
			return {
				type: 'choice',
				instructions: question.instructions,
				criteria: { ...question.criteria },
			};
		case 'score':
			return {
				type: 'score',
				instructions: question.instructions,
				criteria: [...question.criteria],
			};
	}
}

/**
 * Render a question set into the vendor's `questions` map. The builders in
 * `lib/decision/questions.ts` have already validated each question, so the only
 * thing left to refuse here is an empty set — which would bill a round trip for
 * nothing.
 */
export function encodeQuestions(questions: QuestionSet): WireQuestions {
	const ids = Object.keys(questions);
	if (ids.length === 0) {
		throw new DecisionWireError('A decision request needs at least one question.');
	}
	const encoded: WireQuestions = {};
	for (const id of ids) {
		encoded[id] = encodeQuestion(questions[id] as DecisionQuestion);
	}
	return encoded;
}

// ─── Decode ────────────────────────────────────────────────────────────────

function requireRecord(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new DecisionWireError(`Decision response: ${what} is not an object.`);
	}
	return value;
}

function requireUnitNumber(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new DecisionWireError(`Decision response: ${what} is not a number in [0, 1].`);
	}
	return value;
}

/**
 * A distribution over exactly the domain we asked about. Both directions are
 * checked: an option we never offered, and an option we offered that carries no
 * probability — a partial distribution cannot be thresholded.
 */
function decodeProbabilities(
	value: unknown,
	domain: readonly string[],
	id: string
): Record<string, number> {
	const raw = requireRecord(value, `answer '${id}' probabilities`);
	const probabilities: Record<string, number> = {};
	for (const key of Object.keys(raw)) {
		if (!domain.includes(key)) {
			throw new DecisionWireError(
				`Decision response: answer '${id}' has a probability for '${echo(key)}', which was not offered.`
			);
		}
		probabilities[key] = requireUnitNumber(raw[key], `answer '${id}' probability for '${key}'`);
	}
	const missing = domain.filter((key) => !hasKey(probabilities, key));
	if (missing.length > 0) {
		throw new DecisionWireError(
			`Decision response: answer '${id}' has no probability for ${missing.map((key) => `'${key}'`).join(', ')}.`
		);
	}
	// Accept rounding noise, but never threshold an invalid distribution.
	const mass = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
	if (Math.abs(mass - 1) > 0.01) {
		throw new DecisionWireError(`Decision response: answer '${id}' probabilities do not sum to 1.`);
	}
	return probabilities;
}

/**
 * Validate the vendor's 0..N-1 legend before decoding its score. Array legends
 * use the same indices. Noncanonical keys are refused, not inferred from order.
 * `decodeScore` translates the validated value and probabilities to our 1..N
 * scale, shared with the language adapter.
 */
function decodeLegend(value: unknown, question: ScoreQuestion, id: string): Record<string, string> {
	const levels = question.criteria.length;
	const entries: [string, unknown][] = Array.isArray(value)
		? value.map((description, index) => [String(index), description])
		: Object.entries(requireRecord(value, `answer '${id}' legend`));
	if (entries.length !== levels) {
		throw new DecisionWireError(
			`Decision response: answer '${id}' was scored against ${entries.length} levels, ` +
				`but ${levels} were sent.`
		);
	}
	const legend: Record<string, string> = {};
	for (const [key, description] of entries) {
		const ordinal = Number(key);
		if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= levels || key !== String(ordinal)) {
			throw new DecisionWireError(
				`Decision response: answer '${id}' has a legend key '${echo(key)}', ` +
					`but the levels that were sent are numbered 0 to ${levels - 1}.`
			);
		}
		if (hasKey(legend, key)) {
			throw new DecisionWireError(
				`Decision response: answer '${id}' has two legend entries for level '${echo(key)}'.`
			);
		}
		legend[key] = typeof description === 'string' ? description : String(description);
	}
	return legend;
}

function decodeNoul(answer: Record<string, unknown>, id: string): DecisionAnswer {
	return { kind: 'noul', probability: requireUnitNumber(answer['noul'], `answer '${id}' noul`) };
}

function decodeChoice(
	answer: Record<string, unknown>,
	question: ChoiceQuestion,
	id: string
): DecisionAnswer {
	const options = Object.keys(question.criteria);
	const value = answer['choice'];
	if (typeof value !== 'string' || !options.includes(value)) {
		throw new DecisionWireError(
			`Decision response: answer '${id}' chose '${echo(value)}', which is not one of the ` +
				`${options.length} options that were sent.`
		);
	}
	return {
		kind: 'choice',
		value,
		probabilities: decodeProbabilities(answer['probabilities'], options, id),
		confidence: requireUnitNumber(answer['confidence'], `answer '${id}' confidence`),
	};
}

function decodeScore(
	answer: Record<string, unknown>,
	question: ScoreQuestion,
	id: string
): DecisionAnswer {
	const legend = decodeLegend(answer['legend'], question, id);
	const levelKeys = Object.keys(legend);
	const value = answer['score'];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new DecisionWireError(`Decision response: answer '${id}' score is not a number.`);
	}
	// A score may land BETWEEN levels, but never outside the scale it was given.
	// Unconditional, because `decodeLegend` guarantees numeric ordinal keys: a
	// range check that skipped itself on an unexpected legend shape would let an
	// out-of-domain answer arrive as a verdict, which is exactly the case it is
	// there for.
	const numericKeys = levelKeys.map((key) => Number(key));
	const low = Math.min(...numericKeys);
	const high = Math.max(...numericKeys);
	if (value < low || value > high) {
		throw new DecisionWireError(
			`Decision response: answer '${id}' scored ${value}, outside its ${low}–${high} legend.`
		);
	}
	const probabilities = decodeProbabilities(answer['probabilities'], levelKeys, id);
	// Keep the public scale shared with the language adapter at 1..N. Both the
	// weighted value and every probability key must move by the same offset.
	return {
		kind: 'score',
		value: value + 1,
		levels: [...question.criteria],
		probabilities: Object.fromEntries(
			Object.entries(probabilities).map(([key, probability]) => [
				String(Number(key) + 1),
				probability,
			])
		),
		confidence: requireUnitNumber(answer['confidence'], `answer '${id}' confidence`),
	};
}

function decodeAnswer(value: unknown, question: DecisionQuestion, id: string): DecisionAnswer {
	const answer = requireRecord(value, `answer '${id}'`);
	if (answer['type'] !== question.type) {
		throw new DecisionWireError(
			`Decision response: answer '${id}' came back as '${echo(answer['type'])}', ` +
				`but '${question.type}' was asked.`
		);
	}
	switch (question.type) {
		case 'noul':
			return decodeNoul(answer, id);
		case 'choice':
			return decodeChoice(answer, question, id);
		case 'score':
			return decodeScore(answer, question, id);
	}
}

/**
 * Decode the `answers` member against the question set that produced it. The
 * key sets must match exactly in both directions: a missing key means we are
 * about to read `undefined` as a verdict, and an extra key means the model
 * answered something we never asked.
 */
export function decodeAnswers(
	questions: QuestionSet,
	value: unknown
): Record<string, DecisionAnswer> {
	const raw = requireRecord(value, 'answers');
	const answers: Record<string, DecisionAnswer> = {};
	for (const id of Object.keys(questions)) {
		if (!hasKey(raw, id)) {
			throw new DecisionWireError(`Decision response: no answer for question '${id}'.`);
		}
		answers[id] = decodeAnswer(raw[id], questions[id] as DecisionQuestion, id);
	}
	const extra = Object.keys(raw).filter((id) => !hasKey(questions, id));
	if (extra.length > 0) {
		throw new DecisionWireError(
			`Decision response: answered ${extra.map((id) => `'${echo(id)}'`).join(', ')}, ` +
				'which was not asked.'
		);
	}
	return answers;
}

/**
 * Map the vendor's snake_case counters onto the repo's `TokenUsage`. Unlike the
 * language plane's `normalizeUsage`, a missing counter is an error rather than
 * a zero: output is billed at nothing here, so a silent zero on the INPUT side
 * would make the whole plane look free to the enforced ceiling.
 */
export function decodeUsage(value: unknown): TokenUsage {
	const raw = requireRecord(value, 'usage');
	const read = (key: 'input_tokens' | 'output_tokens'): number => {
		const count = raw[key];
		if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
			throw new DecisionWireError(`Decision response: usage.${key} is not a token count.`);
		}
		return count;
	};
	const promptTokens = read('input_tokens');
	const completionTokens = read('output_tokens');
	return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * Validate and decode a whole response body. The reported model is read back
 * rather than assumed: a provider-side reroute onto another version is exactly
 * what the pinned model id exists to catch.
 */
export function decodeResponse(questions: QuestionSet, body: unknown): DecodedDecisionResponse {
	const raw = requireRecord(body, 'body');
	const modelUsed = raw['model'];
	if (typeof modelUsed !== 'string' || modelUsed.trim().length === 0) {
		throw new DecisionWireError('Decision response: no model id reported.');
	}
	const usage = decodeUsage(raw['usage']);
	try {
		return { answers: decodeAnswers(questions, raw['answers']), usage, modelUsed };
	} catch (error) {
		// A rejected answer can still be billed. Carry only validated accounting
		// metadata to dispatch, never the response body or an untrusted usage value.
		if (error instanceof DecisionWireError) {
			throw new DecisionWireError(error.message, { usage, modelUsed });
		}
		throw error;
	}
}
