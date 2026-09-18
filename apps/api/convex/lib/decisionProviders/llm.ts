'use node';

/**
 * Decision plane — the language-backed adapter.
 *
 * The path every install WITHOUT a decision key runs, which is what makes
 * `DEFAULT_DECISION_KIND = 'llm'` mean "exactly today's behaviour" and what
 * makes reverting the whole plane a dropdown rather than a revert. It is not a
 * stub: it answers the same question sets the native adapter answers, through
 * the existing LANGUAGE plane, and returns the same `DecisionResult`.
 *
 * What it can and cannot do:
 *
 *   • It renders a question set into a zod schema plus a prompt, so a Choice is
 *     an enum the model cannot answer outside, a Score is a whole level number
 *     and a Noul is a number in [0, 1].
 *   • It CANNOT produce a distribution. A text model reports one answer, not
 *     the probability mass behind it, so the probabilities come back DEGENERATE
 *     (1 on the answer, 0 everywhere else) and every result is stamped
 *     `calibrated: false`. Nothing here is allowed to imply calibration it does
 *     not have — a threshold that trusted these numbers would be reading the
 *     model's willingness to commit, not its accuracy.
 *
 * The rendering is DETERMINISTIC: the same question set produces a byte-
 * identical prompt, and the golden tests beside this file pin it. Two adapters
 * that describe the same question differently would answer it differently, and
 * the agreement and calibration statistics the rollout gates on would be
 * measuring our own wording drift.
 *
 * This adapter does NOT resolve a model. The dispatch hands it the
 * `LanguageModel` the language plane already resolved (see
 * {@link LlmBackedDecisionRequest}) — resolving one here would give the
 * deployment two independent answers to "which model writes", and would pull
 * `lib/llmProvider.ts` into the decision registry.
 *
 * Node-only, as is the registry that imports it: it reaches the AI SDK through
 * `lib/llm/dispatch.ts`. The isolate-safe surface of this plane is `./types.ts`
 * and `lib/decision/questions.ts`, which the schema chain imports directly.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { TokenUsage } from '../../agent/steps/types';
import type {
	AnswersFor,
	ChoiceQuestion,
	DecisionAnswer,
	DecisionQuestion,
	NoulQuestion,
	QuestionSet,
	ScoreQuestion,
} from '../decision/questions';
import { runLlmObject } from '../llm/dispatch';
import type { ProviderClientConfig } from '../llmProviders/types';
import type {
	DecisionProviderAdapter,
	DecisionRequest,
	DecisionResult,
	DecisionState,
} from './types';
import { DecisionWireError } from './wire';

/** Same state, same questions, same answer — a decision is not a place for sampling. */
const DECISION_TEMPERATURE = 0;

/** Score levels are numbered from one, matching the legend keys `wire.ts` decodes. */
const FIRST_LEVEL = 1;

/**
 * A degenerate distribution is maximally peaked, so peakedness reads as 1. That
 * is a statement about the shape of the distribution we were able to build, not
 * a belief about the answer: `calibrated: false` is what call sites read before
 * they threshold anything that came out of here.
 */
const DEGENERATE_CONFIDENCE = 1;

/** A provider that reports no usage bills as nothing; it must not also fail an answer we already paid for. */
const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const MAX_ECHOED_VALUE_LENGTH = 80;

/**
 * Truncate before echoing, on the same rule as `wire.ts`: a Choice value comes
 * out of a model reading untrusted inbound mail, and error strings reach logs.
 */
function echo(value: unknown): string {
	const rendered = typeof value === 'string' ? value : JSON.stringify(value);
	if (rendered === undefined) return String(value);
	return rendered.length > MAX_ECHOED_VALUE_LENGTH
		? `${rendered.slice(0, MAX_ECHOED_VALUE_LENGTH)}…`
		: rendered;
}

/**
 * The request shape this adapter needs: a `DecisionRequest` plus the language
 * model the dispatch already resolved. The registry's `ask` signature is the
 * shared one, so the model rides on the request rather than on the client
 * config — the language plane owns its own credentials and this adapter never
 * sees a key.
 */
export interface LlmBackedDecisionRequest extends DecisionRequest {
	readonly model: LanguageModel;
}

function requireLanguageModel(req: DecisionRequest): LanguageModel {
	const model = (req as Partial<LlmBackedDecisionRequest>).model;
	if (typeof model !== 'string' && (typeof model !== 'object' || model === null)) {
		throw new Error(
			'The language-backed decision adapter needs the resolved language model on the request. ' +
				'Ask through the decision dispatch, which resolves the language plane and supplies it.'
		);
	}
	return model;
}

function languageModelId(model: LanguageModel): string {
	return typeof model === 'string' ? model : model.modelId;
}

/**
 * The signal the language call runs under: the caller's own cancellation, the
 * plane's deadline, or both. `runLlmObject` honours a signal (widened for this
 * adapter), so an unbounded socket no longer outlives the request that opened it.
 */
function requestSignal(req: DecisionRequest): AbortSignal | undefined {
	if (req.deadlineMs === undefined) return req.abortSignal;
	const deadline = AbortSignal.timeout(req.deadlineMs);
	return req.abortSignal ? AbortSignal.any([req.abortSignal, deadline]) : deadline;
}

// ─── Schema ────────────────────────────────────────────────────────────────

function questionSchema(question: DecisionQuestion): z.ZodTypeAny {
	switch (question.type) {
		case 'noul':
			return z.number().min(0).max(1);
		case 'choice':
			// An enum, so the answer space IS the option set: a label we never
			// offered fails structured output rather than arriving as a verdict.
			return z.enum(Object.keys(question.criteria));
		case 'score':
			return z.number().int().min(FIRST_LEVEL).max(question.criteria.length);
	}
}

/**
 * Render a question set into the structured-output schema. One key per
 * question, named by the caller's own answer key, so the model's reply is
 * already keyed the way the answers are read.
 */
export function renderDecisionSchema(questions: QuestionSet): z.ZodTypeAny {
	const ids = requireQuestionIds(questions);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const id of ids) {
		shape[id] = questionSchema(questions[id] as DecisionQuestion);
	}
	return z.object(shape);
}

function requireQuestionIds(questions: QuestionSet): string[] {
	const ids = Object.keys(questions);
	if (ids.length === 0) {
		throw new DecisionWireError('A decision request needs at least one question.');
	}
	return ids;
}

// ─── Prompt ────────────────────────────────────────────────────────────────

const PROMPT_PREAMBLE = [
	'Answer every question below about the state, using only what the state says.',
	'Judge nothing that is not there, and write no commentary: the answers are the whole response.',
].join('\n');

const PROMPT_CLOSING = 'Return one answer for every question key above, and no others.';

function renderState(state: DecisionState): string {
	// Objects and arrays are rendered with stable key order (insertion order,
	// as the caller built them), because the prompt has to be byte-stable.
	return typeof state === 'string' ? state : JSON.stringify(state, null, 2);
}

function renderNoul(id: string, question: NoulQuestion): string {
	const lines = [`### ${id} — yes/no probability`, question.instructions];
	if (question.criteria) {
		lines.push(`true means: ${question.criteria.true}`, `false means: ${question.criteria.false}`);
	}
	lines.push(
		'Answer with the probability that this is true, from 0 (certainly false) to 1 (certainly true).'
	);
	return lines.join('\n');
}

function renderChoice(id: string, question: ChoiceQuestion): string {
	const lines = [`### ${id} — one label`, question.instructions, 'Options:'];
	for (const [option, description] of Object.entries(question.criteria)) {
		// A null description means the label speaks for itself; inventing one here
		// would put words in the prompt that the native adapter never sends.
		lines.push(description === null ? `- ${option}` : `- ${option}: ${description}`);
	}
	lines.push('Answer with exactly one of the option labels above, copied verbatim.');
	return lines.join('\n');
}

function renderScore(id: string, question: ScoreQuestion): string {
	const lines = [`### ${id} — ordered score`, question.instructions, 'Levels, lowest first:'];
	question.criteria.forEach((level, index) => {
		lines.push(`${index + FIRST_LEVEL}. ${level}`);
	});
	lines.push(
		`Answer with the whole number ${FIRST_LEVEL} to ${question.criteria.length} of the level that fits best.`
	);
	return lines.join('\n');
}

function renderQuestion(id: string, question: DecisionQuestion): string {
	switch (question.type) {
		case 'noul':
			return renderNoul(id, question);
		case 'choice':
			return renderChoice(id, question);
		case 'score':
			return renderScore(id, question);
	}
}

/**
 * Render the state and the question set into the prompt. Deterministic by
 * construction — no timestamps, no ids, no set iteration — and pinned by the
 * golden tests, because the wording is half of what an answer means.
 */
export function renderDecisionPrompt(state: DecisionState, questions: QuestionSet): string {
	const blocks = requireQuestionIds(questions).map((id) =>
		renderQuestion(id, questions[id] as DecisionQuestion)
	);
	return [
		PROMPT_PREAMBLE,
		'',
		'## State',
		'',
		renderState(state),
		'',
		'## Questions',
		'',
		blocks.join('\n\n'),
		'',
		PROMPT_CLOSING,
		'',
	].join('\n');
}

// ─── Answers ───────────────────────────────────────────────────────────────

/** 1 on the answer, 0 on everything else. The honest shape of "one label came back". */
function degenerate(domain: readonly string[], chosen: string): Record<string, number> {
	const probabilities: Record<string, number> = {};
	for (const key of domain) {
		probabilities[key] = key === chosen ? 1 : 0;
	}
	return probabilities;
}

function mapNoul(value: unknown, id: string): DecisionAnswer {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new DecisionWireError(
			`Language-backed decision: answer '${id}' is '${echo(value)}', not a probability in [0, 1].`
		);
	}
	return { kind: 'noul', probability: value };
}

function mapChoice(value: unknown, question: ChoiceQuestion, id: string): DecisionAnswer {
	const options = Object.keys(question.criteria);
	if (typeof value !== 'string' || !options.includes(value)) {
		throw new DecisionWireError(
			`Language-backed decision: answer '${id}' chose '${echo(value)}', which is not one of the ` +
				`${options.length} options that were sent.`
		);
	}
	return {
		kind: 'choice',
		value,
		probabilities: degenerate(options, value),
		confidence: DEGENERATE_CONFIDENCE,
	};
}

function mapScore(value: unknown, question: ScoreQuestion, id: string): DecisionAnswer {
	const levels = question.criteria;
	const level = typeof value === 'number' ? value : Number.NaN;
	if (!Number.isInteger(level) || level < FIRST_LEVEL || level > levels.length) {
		throw new DecisionWireError(
			`Language-backed decision: answer '${id}' scored '${echo(value)}', not a whole level ` +
				`between ${FIRST_LEVEL} and ${levels.length}.`
		);
	}
	// Keyed like the native legend so a composite reads the same under either
	// adapter. A language model picks a level, so the score never lands between two.
	const levelKeys = levels.map((_level, index) => String(index + FIRST_LEVEL));
	return {
		kind: 'score',
		value: level,
		levels: [...levels],
		probabilities: degenerate(levelKeys, String(level)),
		confidence: DEGENERATE_CONFIDENCE,
	};
}

function mapAnswer(value: unknown, question: DecisionQuestion, id: string): DecisionAnswer {
	switch (question.type) {
		case 'noul':
			return mapNoul(value, id);
		case 'choice':
			return mapChoice(value, question, id);
		case 'score':
			return mapScore(value, question, id);
	}
}

/**
 * Map a structured-output object onto the plane's answers, REJECTING anything
 * that disagrees with the question set instead of repairing it. The schema
 * already constrains the model, so a disagreement here means the schema and the
 * question set drifted apart — silently coercing it would corrupt exactly the
 * statistics that decide whether this plane is trusted at all.
 */
export function mapAnswers(questions: QuestionSet, value: unknown): Record<string, DecisionAnswer> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new DecisionWireError('Language-backed decision: the response is not an object.');
	}
	const raw = value as Record<string, unknown>;
	const answers: Record<string, DecisionAnswer> = {};
	for (const id of requireQuestionIds(questions)) {
		if (!Object.prototype.hasOwnProperty.call(raw, id)) {
			throw new DecisionWireError(`Language-backed decision: no answer for question '${id}'.`);
		}
		answers[id] = mapAnswer(raw[id], questions[id] as DecisionQuestion, id);
	}
	const extra = Object.keys(raw).filter(
		(id) => !Object.prototype.hasOwnProperty.call(questions, id)
	);
	if (extra.length > 0) {
		throw new DecisionWireError(
			`Language-backed decision: answered ${extra.map((id) => `'${echo(id)}'`).join(', ')}, ` +
				'which was not asked.'
		);
	}
	return answers;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export const llmDecisionAdapter: DecisionProviderAdapter<'llm'> = {
	kind: 'llm',
	label: 'Language model (uncalibrated)',
	docsUrl: 'https://docs.owlat.app/developer/providers',
	// The language plane owns the model id, so this adapter has none of its own
	// and the settings card leaves the model field to that plane.
	defaultModel: '',
	calibrated: false,
	isLocal: false,
	async ask(_cfg: ProviderClientConfig, req: DecisionRequest): Promise<DecisionResult> {
		const model = requireLanguageModel(req);
		const signal = requestSignal(req);
		const dispatched = await runLlmObject({
			model,
			schema: renderDecisionSchema(req.questions),
			prompt: renderDecisionPrompt(req.state, req.questions),
			temperature: DECISION_TEMPERATURE,
			...(signal ? { abortSignal: signal } : {}),
		});
		return {
			answers: mapAnswers(req.questions, dispatched.object) as AnswersFor<QuestionSet>,
			usage: dispatched.tokenUsage ?? NO_USAGE,
			modelUsed: dispatched.modelUsed ?? languageModelId(model),
			provenance: 'llm-backed',
			calibrated: false,
		};
	},
	/**
	 * Nothing to validate: this adapter carries no credential of its own, and the
	 * language plane fails loudly on its own misconfiguration. Throwing here
	 * would break the one install this path exists for — the one that entered no
	 * decision key at all.
	 */
	validateCredentials(_cfg: ProviderClientConfig): void {},
};
