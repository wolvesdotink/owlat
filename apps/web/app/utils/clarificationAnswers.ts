/**
 * The answer rules shared by both clarification surfaces: which value a
 * question starts with, when a set of answers may be submitted, and what is
 * submitted.
 *
 * Pure (no Vue, no i18n instance): `ClarificationQuestions.vue` holds the
 * working values and calls these with the reader's locale.
 */
import {
	canonicalOption,
	localizedQuestionCopy,
	type LocalizableClarificationQuestion,
} from '~/utils/clarificationLocale';

/** Who supplied an answer: the person, or answer-memory replaying an earlier one. */
export type ClarificationAnswerSource = 'user' | 'memory';

/** A clarification question as both surfaces carry it. */
export interface ClarificationQuestionInput extends LocalizableClarificationQuestion {
	id: string;
	/** The WHY line (Postbox only: provenance + the "never your password" promise). */
	attribution?: string | undefined;
	/**
	 * The stored answer. On team-inbox messages answer-memory writes one with
	 * `source: 'memory'` before the person sees the card; Postbox answers carry
	 * no source and are never pre-filled.
	 */
	answer?: { value: string; source?: ClarificationAnswerSource | undefined } | undefined;
}

/** One submitted answer: the canonical value and where it came from. */
export interface ClarificationAnswer {
	questionId: string;
	value: string;
	source: ClarificationAnswerSource;
}

/**
 * The answer Owlat pre-picked from the person's earlier answer to the same
 * question, in the reader's locale so it matches the chip it highlights.
 * Undefined unless answer-memory filled it.
 */
export function rememberedDisplayAnswer(
	question: ClarificationQuestionInput,
	locale: string
): string | undefined {
	if (question.answer?.source !== 'memory') return undefined;
	const index = question.options?.indexOf(question.answer.value) ?? -1;
	return index >= 0
		? localizedQuestionCopy(question, locale).options[index]
		: question.answer.value;
}

/** Whether a question's working value counts as an answer. */
export function isAnswered(
	values: Record<string, string | undefined>,
	questionId: string
): boolean {
	return (values[questionId] ?? '').trim().length > 0;
}

/**
 * The completeness rule. `requireAll` needs every question answered; otherwise
 * one answer is enough and only the answered questions are sent.
 */
export function canSubmitClarification(
	questions: readonly ClarificationQuestionInput[],
	values: Record<string, string | undefined>,
	requireAll: boolean
): boolean {
	if (questions.length === 0) return false;
	return requireAll
		? questions.every((q) => isAnswered(values, q.id))
		: questions.some((q) => isAnswered(values, q.id));
}

/**
 * The answers to submit, one per answered question. A chip picked in the
 * reader's language is mapped back to the canonical English option, which is
 * what answer-memory matches on. An answer whose canonical value is the one
 * answer-memory filled in goes back as `source: 'memory'`, so the backend does
 * not capture a replayed fact again as the person's own.
 */
export function collectClarificationAnswers(
	questions: readonly ClarificationQuestionInput[],
	values: Record<string, string | undefined>,
	locale: string
): ClarificationAnswer[] {
	return questions.flatMap((question) => {
		if (!isAnswered(values, question.id)) return [];
		const value = canonicalOption(question, locale, values[question.id]!.trim());
		const source: ClarificationAnswerSource =
			question.answer?.source === 'memory' && question.answer.value === value ? 'memory' : 'user';
		return [{ questionId: question.id, value, source }];
	});
}
