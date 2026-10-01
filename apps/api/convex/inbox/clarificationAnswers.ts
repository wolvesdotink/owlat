/**
 * Answer kinds and file answers for the two background clarification loops (the
 * inbound agent `clarify` step and the Postbox Reply Queue).
 *
 * Pure (no ctx, no 'use node') so both loops, the walker resume and the answer
 * mutations share one reading of a question: which input the card shows
 * (`answerKind`), which remembered answers are pre-picked, and how a picked or
 * uploaded file reaches the draft as a trusted fact.
 */

import { formatDraftGap, type AskAnswerKind } from '@owlat/shared/answerMode';
import { detectInjection } from '../agent/steps/security_scan/patterns';

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

/**
 * Every file an answer carries: `files` when the owner gave several, else the
 * single `file`. Rows written before multi-file answers only have `file`.
 */
export function answerFiles<F>(
	answer: { file?: F | undefined; files?: readonly F[] | undefined } | undefined
): readonly F[] {
	if (!answer) return [];
	if (answer.files && answer.files.length > 0) return answer.files;
	return answer.file ? [answer.file] : [];
}

const MAX_NOTE_FILENAME_CHARS = 120;

/**
 * Trusted lines for the draft about files the owner attached through a file
 * answer, so the reply mentions the attachment instead of only quoting its
 * filename. The owner chose the file, but its name may have come in on a mail
 * attachment, so it is flattened to one short line before it enters the
 * trusted block. '' when no question carries a file.
 *
 * `attached` (the team inbox, where the answer puts the file on the reply in
 * the same transaction) says the file is attached. `pending` (the Postbox
 * Reply Queue, where no draft exists yet and the web attaches the file when it
 * applies the prepared reply, `needsReplyPrepared.getPreparedDraft` `files`)
 * says it will be. A bare upload is held by the thread meanwhile, so the note
 * and `files` name the same files.
 */
export function buildFileAnswerNotes(
	questions: ReadonlyArray<{
		answer?:
			| {
					file?: { source?: string; filename: string } | undefined;
					files?: ReadonlyArray<{ source?: string; filename: string }> | undefined;
			  }
			| undefined;
	}>,
	mode: 'attached' | 'pending' = 'attached'
): string {
	const lines: string[] = [];
	for (const file of questions.flatMap((q) => answerFiles(q.answer))) {
		const filename = file.filename
			.replace(/[\r\n"]+/g, ' ')
			.trim()
			.slice(0, MAX_NOTE_FILENAME_CHARS);
		if (!filename) continue;
		lines.push(
			mode === 'attached'
				? `- The file "${filename}" is attached to this reply; mention it naturally.`
				: `- The file "${filename}" will be attached to this reply; mention it naturally.`
		);
	}
	return lines.join('\n');
}

/** Longest starter reply a Reply Queue clarification card stores. */
export const MAX_CLARIFICATION_DRAFT_CHARS = 4000;

const MAX_GAP_LABEL_CHARS = 80;

/**
 * The `[[...]]` placeholder for each file question still waiting on the owner,
 * in question order. A reply drafted before the files arrive writes these where
 * the files would be handed over, so it never claims an attachment that is not
 * there, and the composer's send guard holds the reply until they are filled.
 * The label is the question, which the model wrote from the email: one that
 * reads like an injection falls back to a neutral label.
 */
export function openFileGaps(
	questions: ReadonlyArray<{
		slotType: string;
		text: string;
		answerKind?: AskAnswerKind | undefined;
		answer?: unknown;
	}>
): string[] {
	const gaps: string[] = [];
	for (const q of questions) {
		if (!isFileQuestion(q) || q.answer !== undefined) continue;
		const label = q.text
			.replace(/\s+/g, ' ')
			.replace(/\?+\s*$/, '')
			.trim()
			.slice(0, MAX_GAP_LABEL_CHARS)
			.trim();
		const safe = label.length > 0 && !detectInjection(label).detected;
		gaps.push(formatDraftGap(safe ? label : 'attach the requested files'));
	}
	return gaps;
}

/**
 * The trusted line telling the drafter about {@link openFileGaps}. '' when no
 * file is outstanding.
 */
export function buildOpenFileNote(gaps: readonly string[]): string {
	if (gaps.length === 0) return '';
	return `- The files the sender asked for are not attached yet; the owner will add them. Do not say anything is attached or enclosed. Where the reply would hand them over, write this placeholder exactly as given: ${gaps.join(' ')}`;
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
