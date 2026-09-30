/**
 * Answer kinds and file answers for the two background clarification loops (the
 * inbound agent `clarify` step and the Postbox Reply Queue).
 *
 * Pure (no ctx, no 'use node') so both loops, the walker resume and the answer
 * mutations share one reading of a question: which input the card shows
 * (`answerKind`), which remembered answers are pre-picked, and how a picked or
 * uploaded file reaches the draft as a trusted fact.
 */

import type { AskAnswerKind } from '@owlat/shared/answerMode';

/**
 * The canonical "the file doesn't exist yet" option on a file question. English
 * like the rest of the canonical question copy; `translations` carry the other
 * locales. Answering with it tells the drafter to promise the file for later.
 */
export const NOT_READY_OPTION = "It isn't ready yet";

/**
 * Which input a question gets, from its slot kind: a date picker for
 * `date_time`, a number field for `price_number`, a file slot for `attachment`,
 * chips when the extractor suggested answers, free text otherwise. Every kind
 * still accepts free text in the card.
 */
export function answerKindForSlot(
	slotType: string,
	options?: readonly string[] | undefined
): AskAnswerKind {
	if (slotType === 'date_time') return 'date';
	if (slotType === 'price_number') return 'number';
	if (slotType === 'attachment') return 'file';
	if (options && options.length > 0) return 'choice';
	return 'text';
}

/** `question` with its `answerKind` set from {@link answerKindForSlot}. */
export function withAnswerKind<Q extends { slotType: string; options?: string[] | undefined }>(
	question: Q
): Q & { answerKind: AskAnswerKind } {
	return { ...question, answerKind: answerKindForSlot(question.slotType, question.options) };
}

/**
 * Whether a question asks for a file. Rows written before `answerKind` existed
 * are recognised by their slot kind.
 */
export function isFileQuestion(question: {
	slotType: string;
	answerKind?: AskAnswerKind | undefined;
}): boolean {
	if (question.answerKind !== undefined) return question.answerKind === 'file';
	return question.slotType === 'attachment';
}

/**
 * Pre-pick the questions a stored standing answer resolves, marked
 * `source: 'memory'` so the card shows them as "last time" instead of using them
 * silently. Unfilled questions pass through untouched.
 */
export function applyMemoryFills<Q extends { id: string }>(
	questions: readonly Q[],
	fills: readonly { questionId: string; value: string }[],
	at: number
): (Q & { answer?: { value: string; source: 'memory'; at: number } })[] {
	const byQuestion = new Map(fills.map((f) => [f.questionId, f.value] as const));
	return questions.map((q) => {
		const value = byQuestion.get(q.id);
		return value === undefined ? q : { ...q, answer: { value, source: 'memory' as const, at } };
	});
}

interface CandidateLike {
	source: 'semanticFile' | 'mailAttachment';
	id: string;
	filename: string;
	title?: string | undefined;
}

/**
 * The file candidate an answer names by its chip label. Older clients answer a
 * "which file?" question with the option text (the candidate's title, or its
 * filename when it has none) rather than a file reference, so the label is
 * matched back to the candidate it was built from.
 */
export function candidateForLabel<C extends CandidateLike>(
	candidates: readonly C[] | undefined,
	label: string
): C | undefined {
	const wanted = label.trim();
	if (!candidates || wanted.length === 0) return undefined;
	return candidates.find(
		(c) => (c.title?.trim() || c.filename) === wanted || c.filename === wanted
	);
}

const MAX_NOTE_FILENAME_CHARS = 120;

/**
 * Trusted lines for the draft about files the owner attached through a file
 * answer, so the reply mentions the attachment instead of only quoting its
 * filename. The owner chose the file, but its name may have come in on a mail
 * attachment, so it is flattened to one short line before it enters the
 * trusted block. '' when no question carries a file.
 */
export function buildFileAnswerNotes(
	questions: ReadonlyArray<{ answer?: { file?: { filename: string } | undefined } | undefined }>
): string {
	const lines: string[] = [];
	for (const q of questions) {
		const filename = q.answer?.file?.filename
			.replace(/[\r\n"]+/g, ' ')
			.trim()
			.slice(0, MAX_NOTE_FILENAME_CHARS);
		if (filename) {
			lines.push(`- The file "${filename}" is attached to this reply; mention it naturally.`);
		}
	}
	return lines.join('\n');
}

/** Join two confirmed-facts blocks, skipping empty ones. */
export function joinConfirmedBlocks(...blocks: readonly string[]): string {
	return blocks.filter((b) => b.trim().length > 0).join('\n');
}

/**
 * The owner's answer to the attachment question, for the resumed draft:
 *   - undefined — no file question was answered (or none was asked); the draft
 *     step searches Files as usual. The abandoned-question fallback lands here.
 *   - the stored suggestion — the owner picked or uploaded a Files row, which
 *     `answerClarification` recorded as the message's confident suggestion.
 *   - null — the owner answered without a file ("It isn't ready yet", free
 *     text, or a copy kept out of Files); nothing is suggested.
 */
export function ownerAttachmentFromAnswers<
	S extends { ambiguous: boolean; candidates: ReadonlyArray<{ fileId: string }> },
>(
	questions: ReadonlyArray<{
		slotType: string;
		answerKind?: AskAnswerKind | undefined;
		answer?: { file?: { source: string; id: string } | undefined } | undefined;
	}>,
	stored: S | undefined
): S | null | undefined {
	const answered = questions.find((q) => isFileQuestion(q) && q.answer !== undefined);
	if (!answered) return undefined;
	const file = answered.answer?.file;
	if (!file || file.source !== 'semanticFile') return null;
	const pick = stored && !stored.ambiguous ? stored.candidates[0] : undefined;
	return pick && pick.fileId === file.id ? stored : null;
}
