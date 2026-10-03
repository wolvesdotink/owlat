/**
 * Answer mode "Draft with AI that asks first": the pure decisions.
 *
 * Everything here is model-free and context-free so it unit-tests directly and
 * imports into both runtimes: the Node action (mail/ai/composeDraft.ts) that
 * runs the gap check and the draft, and the store (mail/ai/composeDraftStore.ts)
 * that records answers.
 *
 *  - Files: rank what the search found against what the other party asked
 *    for, and pick one of the three outcomes (plan §06): one confident match
 *    is attached without a question, several close ones become a "which file"
 *    question, nothing becomes an upload question with near misses and the
 *    "It isn't ready yet" way out.
 *  - Round 2: "It isn't ready yet" asks "When can you send it?" and the answer
 *    turns into the date the draft promises and the follow-up reminder.
 *  - Gaps: every question still open when the draft is written becomes a
 *    `[[...]]` placeholder (`@owlat/shared/answerMode`), and the drafter is
 *    told the exact text to write.
 */

import type { Infer } from 'convex/values';
import { formatDraftGap } from '@owlat/shared/answerMode';
import { pickAttachmentSuggestion, MATCH_FLOOR } from '../../inbox/attachmentMatch';
import { isCredentialSolicitation, legacyAttributionOrigin } from '../../inbox/clarificationSlots';
import { detectInjection } from '../../agent/steps/security_scan/patterns';
import { formatPromisedDay, weekdayAfter } from './composeDraftDates';
import { NOT_READY_OPTION } from '../../inbox/clarificationAnswers';
import type { FoundFile } from '../../inbox/attachmentSuggest';
import type {
	clarificationFileCandidateValidator,
	clarificationFileRefValidator,
	needsReplyClarificationQuestionValidator,
} from '../../lib/validators/clarification';

export type AskQuestion = Infer<typeof needsReplyClarificationQuestionValidator>;
export type AskFileRef = Infer<typeof clarificationFileRefValidator>;
export type AskFileCandidate = Infer<typeof clarificationFileCandidateValidator>;
/**
 * Where a question came from: a fresh provenance, or the stored question a
 * follow-up copies it from. A question stored before `origin` existed carries
 * only the legacy `attribution` sentence, which is read but never written.
 */
export type AskProvenance = Pick<AskQuestion, 'attribution' | 'origin'>;

/** Question ids the drafter assigns itself (slot questions are `clarify_N`). */
export const FILE_QUESTION_ID = 'file_request';
export const FOLLOW_UP_QUESTION_ID = 'follow_up_date';

/** A near miss offered with "nothing found" must score at least this. */
export const NEAR_MATCH_FLOOR = 0.15;
/** Near misses shown with an upload question. */
export const NEAR_MATCH_LIMIT = 3;

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

/** Spellings of each month (English and German, full and short) → 0-based month. */
const MONTH_WORDS: ReadonlyMap<string, number> = new Map(
	[
		['january', 'jan', 'januar', 'jänner'],
		['february', 'feb', 'februar'],
		['march', 'mar', 'märz', 'maerz'],
		['april', 'apr'],
		['may', 'mai'],
		['june', 'jun', 'juni'],
		['july', 'jul', 'juli'],
		['august', 'aug'],
		['september', 'sep', 'sept'],
		['october', 'oct', 'oktober', 'okt'],
		['november', 'nov'],
		['december', 'dec', 'dezember', 'dez'],
	].flatMap((words, month) => words.map((word) => [word, month] as const))
);

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0);
}

/** The month a request names ("the September invoice"), if exactly one. */
export function monthInText(text: string): number | undefined {
	const found = new Set<number>();
	for (const token of tokens(text)) {
		const month = MONTH_WORDS.get(token);
		if (month !== undefined) found.add(month);
	}
	return found.size === 1 ? [...found][0] : undefined;
}

/**
 * The month a file is about, from its name or title: a month word, or a
 * `2026-09` / `2026_09` / `09-2026` date part. Undefined when there is none or
 * the name is ambiguous.
 */
export function monthInFileName(filename: string, title?: string): number | undefined {
	const text = `${filename} ${title ?? ''}`;
	const byWord = monthInText(text);
	if (byWord !== undefined) return byWord;
	const found = new Set<number>();
	for (const match of text.matchAll(/(?:^|\D)(20\d{2})[-_.](\d{2})(?!\d)/g)) {
		const month = Number(match[2]) - 1;
		if (month >= 0 && month < 12) found.add(month);
	}
	for (const match of text.matchAll(/(?:^|\D)(\d{2})[-_.](20\d{2})(?!\d)/g)) {
		const month = Number(match[1]) - 1;
		if (month >= 0 && month < 12) found.add(month);
	}
	return found.size === 1 ? [...found][0] : undefined;
}

/** Words in a request that say nothing about which file is meant. */
const REQUEST_NOISE = new Set([
	'for',
	'from',
	'with',
	'and',
	'this',
	'that',
	'last',
	'next',
	'month',
	'file',
	'files',
	'document',
	'please',
	'again',
]);

/**
 * How well a file name (and title) matches the request, 0 to 1: the share of
 * the request's meaningful words that appear in it. A month word counts as
 * present when the file is about the same month in any spelling.
 */
export function scoreFileName(query: string, filename: string, title?: string): number {
	const wanted = tokens(query).filter((t) => t.length >= 3 && !REQUEST_NOISE.has(t));
	if (wanted.length === 0) return 0;
	const have = new Set(tokens(`${filename} ${title ?? ''}`));
	const fileMonth = monthInFileName(filename, title);
	let hits = 0;
	for (const word of wanted) {
		const month = MONTH_WORDS.get(word);
		if (month !== undefined ? month === fileMonth : have.has(word)) hits += 1;
	}
	return hits / wanted.length;
}

/** A ranked candidate: carries `fileId` for the shared ranker and why it may be wrong. */
export interface RankedFile extends AskFileCandidate {
	fileId: string;
	/** True when the request names a period and the file is about another one. */
	isPeriodMismatch: boolean;
}

/**
 * Score every hit against the request and mark the ones about another period
 * ("August" for a September invoice). Best first; the same file found twice
 * (by both searches) keeps its best score.
 */
export function rankFoundFiles(query: string, found: readonly FoundFile[]): RankedFile[] {
	const wantedMonth = monthInText(query);
	const byKey = new Map<string, RankedFile>();
	for (const file of found) {
		const nameScore = scoreFileName(query, file.filename, file.title);
		const score = Math.max(file.score, nameScore);
		const fileMonth = monthInFileName(file.filename, file.title);
		const isPeriodMismatch =
			wantedMonth !== undefined && fileMonth !== undefined && fileMonth !== wantedMonth;
		const key = `${file.source}:${file.id}`;
		const previous = byKey.get(key);
		if (previous && previous.score >= score) continue;
		byKey.set(key, {
			source: file.source,
			id: file.id,
			fileId: key,
			filename: file.filename,
			...(file.title ? { title: file.title } : {}),
			mimeType: file.mimeType,
			size: file.size,
			score,
			isPeriodMismatch,
			...(isPeriodMismatch && fileMonth !== undefined ? { note: MONTH_NAMES[fileMonth] } : {}),
		});
	}
	return [...byKey.values()].sort((a, b) => b.score - a.score);
}

export type FileOutcome =
	| { kind: 'attach'; file: RankedFile }
	| { kind: 'choose'; files: RankedFile[] }
	| { kind: 'missing'; near: RankedFile[] };

/**
 * The three outcomes of plan §06. Only a file that clears the match floor and
 * is not about another period may be attached or offered as a choice; when
 * none qualifies, the near misses (lower floor, period mismatches included and
 * noted) go with the upload question.
 */
export function decideFileOutcome(ranked: readonly RankedFile[]): FileOutcome {
	const confident = ranked.filter((f) => f.score >= MATCH_FLOOR && !f.isPeriodMismatch);
	const picked = pickAttachmentSuggestion(confident);
	if (picked.candidates.length === 1 && !picked.ambiguous) {
		return { kind: 'attach', file: picked.candidates[0]! };
	}
	if (picked.candidates.length > 1) return { kind: 'choose', files: picked.candidates };
	const near = ranked
		.filter((f) => f.score >= NEAR_MATCH_FLOOR || f.isPeriodMismatch)
		.slice(0, NEAR_MATCH_LIMIT);
	return { kind: 'missing', near };
}

/** The candidate as stored on a question (drops the ranking-only fields). */
export function toFileCandidate(file: RankedFile): AskFileCandidate {
	return {
		source: file.source,
		id: file.id,
		filename: file.filename,
		...(file.title ? { title: file.title } : {}),
		mimeType: file.mimeType,
		size: file.size,
		score: file.score,
		...(file.note ? { note: file.note } : {}),
	};
}

const MAX_LABEL_CHARS = 60;

/**
 * How the requested file is named in questions and its placeholder. The words
 * come from the email, and an answered question is quoted in the trusted
 * `[CONFIRMED BY OWNER]` block, so wording the injection scan flags is replaced
 * by the generic name.
 */
export function fileRequestLabel(query: string): string {
	const label = query.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS).trim();
	if (label.length === 0 || detectInjection(label).detected) return 'the requested file';
	return label;
}

/**
 * The file question for a `choose` or `missing` outcome, or null when the
 * request text reads like a credential solicitation (the label comes from
 * the email, which is attacker-controlled).
 */
export function buildFileQuestion(
	outcome: Exclude<FileOutcome, { kind: 'attach' }>,
	label: string,
	provenance: AskProvenance
): AskQuestion | null {
	const text =
		outcome.kind === 'choose'
			? `Which file should I attach for "${label}"?`
			: `They asked for "${label}". I couldn't find it in Files or earlier mail.`;
	if (isCredentialSolicitation(text)) return null;
	const candidates = outcome.kind === 'choose' ? outcome.files : outcome.near;
	return {
		id: FILE_QUESTION_ID,
		slotType: 'attachment',
		text,
		...provenanceOf(provenance),
		answerKind: 'file',
		...(outcome.kind === 'missing' ? { options: [NOT_READY_OPTION] } : {}),
		...(candidates.length > 0 ? { fileCandidates: candidates.map(toFileCandidate) } : {}),
	};
}

/**
 * Round 2 after "It isn't ready yet": when the owner can send it. Chips for
 * tomorrow and the day after (by name, on the owner's calendar); the web adds
 * a date picker.
 */
export function buildFollowUpQuestion(
	label: string,
	provenance: AskProvenance,
	now: number,
	timeZone?: string
): AskQuestion {
	return {
		id: FOLLOW_UP_QUESTION_ID,
		slotType: 'date_time',
		text: `When can you send "${label}"?`,
		...provenanceOf(provenance),
		answerKind: 'date',
		options: ['Tomorrow', weekdayAfter(now, 2, timeZone)],
	};
}

/**
 * The provenance fields of a new question: only `origin`, taken from a legacy
 * question's `attribution` sentence when that is all it has (a session stored
 * before `origin` existed, not yet converted by migration 0066).
 */
function provenanceOf({ attribution, origin }: AskProvenance): Pick<AskQuestion, 'origin'> {
	const resolved = origin ?? legacyAttributionOrigin(attribution);
	return resolved ? { origin: resolved } : {};
}

/**
 * The canonical (English) option an answer picked, when the web sent the
 * translated chip label; otherwise the value as given.
 */
export function canonicalAnswerValue(question: AskQuestion, value: string): string {
	const options = question.options ?? [];
	const trimmed = value.trim();
	for (const translation of question.translations ?? []) {
		const index = (translation.options ?? []).indexOf(trimmed);
		if (index >= 0 && options[index] !== undefined) return options[index]!;
	}
	return trimmed;
}

/** Whether an answer to the file question says the file does not exist yet. */
export function isNotReadyAnswer(question: AskQuestion, value: string | undefined): boolean {
	if (question.id !== FILE_QUESTION_ID || value === undefined) return false;
	return canonicalAnswerValue(question, value) === NOT_READY_OPTION;
}

/** The placeholder label for an open question. */
export function gapLabelFor(question: AskQuestion, fileLabel: string | undefined): string {
	if (question.id === FILE_QUESTION_ID) return `attach ${fileLabel ?? 'the requested file'}`;
	return question.text.replace(/\?+\s*$/, '').trim();
}

/** The `[[...]]` placeholder an open question leaves in the draft. */
export function formatGapFor(question: AskQuestion, fileLabel: string | undefined): string {
	return formatDraftGap(gapLabelFor(question, fileLabel));
}

/** Placeholders for every question still without an answer, in question order. */
export function openGapPlaceholders(
	questions: readonly AskQuestion[],
	fileLabel: string | undefined
): string[] {
	const out: string[] = [];
	for (const q of questions) {
		if (q.answer && (q.answer.value.trim().length > 0 || q.answer.file)) continue;
		out.push(formatGapFor(q, fileLabel));
	}
	return out;
}

/**
 * Make sure every placeholder the draft was told to write is in it. A model
 * that dropped one would leave a draft that reads complete while a fact is
 * missing, and the send guard only sees placeholders that are there.
 */
export function ensureGapPlaceholders(text: string, placeholders: readonly string[]): string {
	const missing = placeholders.filter((p) => !text.includes(p));
	if (missing.length === 0) return text;
	return `${text.trimEnd()}\n\n${missing.join('\n')}`;
}

/**
 * {@link ensureGapPlaceholders} within a length limit: the body is cut first,
 * leaving room for every placeholder, so a cap applied later cannot cut one
 * off. A placeholder the cut split in half is dropped from the body and comes
 * back whole at the end.
 */
export function fitGapPlaceholders(
	text: string,
	placeholders: readonly string[],
	maxChars: number
): string {
	const complete = ensureGapPlaceholders(text, placeholders);
	if (complete.length <= maxChars || placeholders.length === 0) return complete.slice(0, maxChars);
	const room = maxChars - placeholders.join('\n').length - 2;
	const cut = text
		.slice(0, Math.max(0, room))
		.replace(/\[\[[^\]]*\]?$/, '')
		.trimEnd();
	return ensureGapPlaceholders(cut, placeholders).slice(0, maxChars);
}

const MAX_INSTRUCTION_CHARS = 2000;

/**
 * The TRUSTED `[CONFIRMED BY OWNER]` content: the owner's answers, the files
 * on the reply, the promise to make, the gaps to leave, and the owner's own
 * instruction. Everything here comes from the authenticated owner or from
 * files they chose, never from the email; `buildDraftMessages` renders it
 * outside the untrusted tags.
 */
export function buildAnswerConfirmedContext(args: {
	questions: readonly AskQuestion[];
	attachedFiles: readonly AskFileRef[];
	gapPlaceholders: readonly string[];
	fileLabel?: string | undefined;
	followUp?: { value: string; at?: number | undefined } | undefined;
	instruction?: string | undefined;
	/** The owner's IANA zone: the promised day is named on their calendar. */
	timeZone?: string | undefined;
}): string {
	const lines: string[] = [];
	for (const q of args.questions) {
		if (!q.answer || q.answer.value.trim().length === 0) continue;
		if (q.id === FILE_QUESTION_ID && q.answer.value === NOT_READY_OPTION) continue;
		lines.push(`- ${q.text.trim()} ${q.answer.value.trim()}`);
	}
	if (args.attachedFiles.length > 0) {
		lines.push(
			`- These files are attached to this reply; mention them naturally: ${args.attachedFiles
				.map((f) => f.filename)
				.join(', ')}`
		);
	}
	if (args.followUp) {
		const date =
			args.followUp.at !== undefined
				? ` (${formatPromisedDay(args.followUp.at, args.timeZone)})`
				: '';
		lines.push(
			`- ${args.fileLabel ? `"${args.fileLabel}"` : 'The requested file'} is not ready yet. Say so and promise to send it by: ${args.followUp.value.trim()}${date}`
		);
	}
	if (args.gapPlaceholders.length > 0) {
		lines.push(
			`- These facts are still missing. Do not guess them. Where each one belongs, write its placeholder exactly as given: ${args.gapPlaceholders.join(' ')}`
		);
	}
	const instruction = args.instruction?.trim().slice(0, MAX_INSTRUCTION_CHARS);
	if (instruction) lines.push(`- What the reply should say, in the owner's words: ${instruction}`);
	return lines.join('\n');
}
