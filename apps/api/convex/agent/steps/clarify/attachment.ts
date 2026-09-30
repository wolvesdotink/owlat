'use node';

/**
 * Attachment clarification helpers for the `clarify` step.
 *
 * Split out of `clarify/index.ts` (per CONVENTIONS.md "Split only above ~500
 * LOC" — do NOT baseline frozen debt) and mirroring how the pure matcher lives
 * in `inbox/attachmentMatch.ts`. Everything here is deterministic (model-free)
 * and FAIL-SOFT: any failure resolves to zero questions so ingest is never
 * blocked and the agent never guesses which file to attach.
 *
 * Three outcomes when the inbound asks for a file (plan §06):
 *   - one confident match  → no question; the `draft` step suggests the file.
 *   - several close matches → "Which file should I attach?" with the matches as
 *     `fileCandidates` (and their titles as `options` for older clients).
 *   - nothing confident     → a file question saying the file wasn't found, with
 *     any weak match as a near candidate and "It isn't ready yet" as a chip.
 */

import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import type { Infer } from 'convex/values';
import {
	computeAttachmentSuggestions,
	type AttachmentSuggestions,
} from '../../../inbox/attachmentSuggest';
import { detectAttachmentRequest, MATCH_FLOOR } from '../../../inbox/attachmentMatch';
import { isCredentialSolicitation } from '../../../inbox/clarificationSlots';
import { NOT_READY_OPTION } from '../../../inbox/clarificationAnswers';
import { translationTargets } from '../../../inbox/clarificationLocalize';
import type { clarificationFileCandidateValidator } from '../../../lib/validators/clarification';
import type { ClarificationQuestion, ClarifyInput } from './index';

/** Cap on how many candidate filenames we offer as pick-one options. */
const MAX_ATTACHMENT_OPTIONS = 4;
const MAX_OPTION_LABEL_CHARS = 80;
const MAX_REQUEST_PHRASE_CHARS = 80;

/** Minimal ctx surface — satisfied by the `clarify` step's execute ctx. */
type AttachmentClarifyCtx = Pick<ActionCtx, 'runAction' | 'runQuery'>;

/** The file question to park on, and which of the two outcomes raised it. */
interface AttachmentClarification {
	question: ClarificationQuestion;
	resolution: 'attachment_ambiguous' | 'attachment_missing';
}

type FileCandidate = Infer<typeof clarificationFileCandidateValidator>;
type SuggestedFile = AttachmentSuggestions['candidates'][number];

/**
 * The question copy is fixed (only the requested-thing phrase and the file
 * titles vary), so its translations ship with it instead of costing a model
 * call. Keyed by interface locale; English is the canonical `text`.
 */
interface QuestionCopy {
	whichFile: string;
	notFound: (phrase: string) => string;
	notFoundGeneric: string;
	notReady: string;
}

const CANONICAL_COPY: QuestionCopy = {
	whichFile: 'Which file should I attach to this reply?',
	notFound: (phrase) => `They asked for “${phrase}”. I couldn't find it in Files.`,
	notFoundGeneric: "They asked for a file. I couldn't find it in Files.",
	notReady: NOT_READY_OPTION,
};

const COPY: Record<string, QuestionCopy> = {
	en: CANONICAL_COPY,
	de: {
		whichFile: 'Welche Datei soll ich an diese Antwort anhängen?',
		notFound: (phrase) => `Angefragt wurde „${phrase}“. Ich habe es nicht in den Dateien gefunden.`,
		notFoundGeneric: 'Angefragt wurde eine Datei. Ich habe sie nicht in den Dateien gefunden.',
		notReady: 'Noch nicht fertig',
	},
};

function candidateLabel(file: SuggestedFile): string {
	return (file.title?.trim() || file.filename).slice(0, MAX_OPTION_LABEL_CHARS);
}

function toFileCandidate(file: SuggestedFile): FileCandidate {
	return {
		source: 'semanticFile',
		id: file.fileId,
		filename: file.filename,
		...(file.title ? { title: file.title } : {}),
		mimeType: file.mimeType,
		size: file.fileSize,
		score: file.score,
	};
}

/** Per-locale renderings for every shipped non-English locale we have copy for. */
function staticTranslations(
	render: (copy: QuestionCopy) => { text: string; options?: string[] }
): NonNullable<ClarificationQuestion['translations']> {
	const out: NonNullable<ClarificationQuestion['translations']> = [];
	for (const locale of translationTargets()) {
		const copy = COPY[locale];
		if (copy) out.push({ locale, ...render(copy) });
	}
	return out;
}

/**
 * Shape an ambiguous attachment choice into the single "which file?" question.
 * The candidates ride along as `fileCandidates` (the Answer mode card shows
 * them as file chips) and, in the same order, as option labels for clients
 * that only render chips. Pure + exported for tests.
 */
export function buildAttachmentQuestion(
	candidates: AttachmentSuggestions['candidates']
): ClarificationQuestion {
	const options: string[] = [];
	const fileCandidates: FileCandidate[] = [];
	for (const candidate of candidates.slice(0, MAX_ATTACHMENT_OPTIONS)) {
		const label = candidateLabel(candidate);
		if (label.length === 0) continue;
		options.push(label);
		fileCandidates.push(toFileCandidate(candidate));
	}
	return {
		id: 'clarify_attachment',
		slotType: 'attachment',
		answerKind: 'file',
		text: CANONICAL_COPY.whichFile,
		options,
		fileCandidates,
		translations: staticTranslations((copy) => ({ text: copy.whichFile, options })),
	};
}

/**
 * The "I couldn't find it" file question: the card offers upload and "Pick from
 * Files"; `nearCandidates` (a weak match, if any) show as "close, but maybe not
 * it"; the only chip is "It isn't ready yet". `phrase` is the requested thing as
 * the sender worded it (untrusted, already credential-checked), or '' for the
 * generic wording. Pure + exported for tests.
 */
export function buildFileNotFoundQuestion(
	phrase: string,
	nearCandidates: AttachmentSuggestions['candidates']
): ClarificationQuestion {
	const render = (copy: QuestionCopy) => ({
		text: phrase ? copy.notFound(phrase) : copy.notFoundGeneric,
		options: [copy.notReady],
	});
	const canonical = render(CANONICAL_COPY);
	return {
		id: 'clarify_attachment',
		slotType: 'attachment',
		answerKind: 'file',
		...canonical,
		...(nearCandidates.length > 0
			? { fileCandidates: nearCandidates.slice(0, MAX_ATTACHMENT_OPTIONS).map(toFileCandidate) }
			: {}),
		translations: staticTranslations(render),
	};
}

/**
 * The sender's own message out of the assembled briefing: the retrieval step
 * appends it last under `[CURRENT MESSAGE]`. The not-found question only looks
 * there, so a request quoted from older history does not raise it.
 */
function currentMessageText(context: string): string {
	const at = context.lastIndexOf('[CURRENT MESSAGE]');
	return at >= 0 ? context.slice(at) : context;
}

// "See attached" / "attached is" mean the sender attached something, not that
// they want a file back. They count for the matcher, not for the not-found ask.
const SENDER_ATTACHED =
	/\b(?:see|find)\s+attached\b|\battached\s+(?:is|are|please\s+find|you'?ll\s+find)\b/gi;

/**
 * The phrase naming the file the sender wants back, or null when the current
 * message asks for no file (or asks for something credential-shaped, which is
 * never turned into a question). Pure + exported for tests.
 */
export function requestedFilePhrase(context: string): string | null {
	const text = currentMessageText(context).replace(SENDER_ATTACHED, ' ');
	const request = detectAttachmentRequest(text);
	if (!request.requested) return null;
	const phrase = request.query
		.replace(/["“”„]/g, '')
		.trim()
		.slice(0, MAX_REQUEST_PHRASE_CHARS);
	if (isCredentialSolicitation(phrase)) return null;
	return phrase;
}

/**
 * Deterministic (model-free) attachment check. When the inbound asks for a
 * document, search the contact-scoped `semanticFiles` and return the file
 * question for an ambiguous or missing match (see the module comment). A single
 * confident match returns null here — the `draft` step surfaces that as a
 * one-tap suggestion rather than a question. FAIL-SOFT: any failure, including a
 * failed file search, → null (a broken search must not read as "nothing found").
 */
export async function detectAttachmentClarification(
	ctx: AttachmentClarifyCtx,
	input: ClarifyInput
): Promise<AttachmentClarification | null> {
	try {
		// Cheap gate first — skip the message read entirely when no document is
		// being asked for (the overwhelmingly common case).
		if (!detectAttachmentRequest(input.context).requested) return null;
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: input.inboundMessageId,
		});
		// computeAttachmentSuggestions folds a search error into "no suggestion";
		// watch the one action it runs so an error still means "don't ask".
		let searchFailed = false;
		const watched = {
			runAction: (async (ref: never, args: never) => {
				try {
					return await ctx.runAction(ref, args);
				} catch (error) {
					searchFailed = true;
					throw error;
				}
			}) as ActionCtx['runAction'],
		};
		const suggestions = await computeAttachmentSuggestions(watched, {
			context: input.context,
			contactId: message?.contactId,
		});
		if (searchFailed) return null;
		if (suggestions?.ambiguous) {
			return {
				question: buildAttachmentQuestion(suggestions.candidates),
				resolution: 'attachment_ambiguous',
			};
		}

		const top = suggestions?.candidates[0];
		if (top && top.score >= MATCH_FLOOR) return null;

		const phrase = requestedFilePhrase(input.context);
		if (phrase === null) return null;
		return {
			question: buildFileNotFoundQuestion(phrase, top ? [top] : []),
			resolution: 'attachment_missing',
		};
	} catch {
		return null;
	}
}
