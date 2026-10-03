/**
 * How a shared-service draft marks a fact it does not have.
 *
 * The one marker is the Answer mode gap placeholder `[[short description]]`
 * (`@owlat/shared/answerMode`): the composer highlights and counts it, and the
 * send guard holds the reply until it is filled. A model left to choose its
 * own marker writes reviewer notes like `[Bitte prüfen: Betrag bestätigen]`,
 * which nothing counts, so their text can go out to the other party. The
 * prompt names the placeholder, and {@link markReviewerNotes} turns the notes a
 * model writes anyway into placeholders before the draft is stored.
 *
 * Pure (no ctx, no 'use node').
 */

import { formatDraftGap } from '@owlat/shared/answerMode';
import { splitQuotedText } from '@owlat/shared/quotedText';

/**
 * The system-prompt paragraph on missing facts. The recallKnowledge sentence
 * only appears when the call passes that tool: a prompt that names a tool the
 * model cannot call invites it to write the call out as text.
 */
export function missingFactInstruction(hasRecallTool: boolean): string {
	const fetch = hasRecallTool
		? ' call the recallKnowledge tool to fetch it rather than guessing. If recall returns nothing relevant,'
		: '';
	return `If you need a specific fact to answer accurately — a price, policy, date,
order status, or a commitment we made — and it is NOT already in the provided
context,${fetch} do NOT assert the missing fact: answer only what the context
supports, and where the reply needs the fact, write [[short description of
what is missing]] in its place. A person fills each placeholder in before the
reply is sent. This is the only way to mark something for them: no notes in
single brackets, comments or reminders such as [Please confirm: ...]. Never
invent facts, prices, policies, or commitments.`;
}

/**
 * Openings of a reviewer note, in the languages the app ships (English and
 * German) plus the usual shorthand. Matched at the start of a bracket's
 * content, case-insensitively, and only as whole words.
 */
const REVIEWER_NOTE_OPENINGS = [
	'please (?:confirm|check|verify|add|insert|fill in|complete|update|review|adjust|clarify)',
	'to be (?:confirmed|checked|verified|added|completed|clarified|defined|determined)',
	'needs? (?:confirmation|checking|verification|review)',
	'(?:confirm|check|verify|insert|add|fill in|missing|placeholder)',
	'note(?: to (?:self|(?:the )?reviewer))?',
	'reviewer note',
	'(?:todo|tbd|tbc|fixme)',
	'bitte (?:prüfen|überprüfen|ergänzen|bestätigen|einfügen|eintragen|anpassen|klären|nachtragen|nachreichen)',
	'zu (?:prüfen|ergänzen|bestätigen|klären)',
	'(?:prüfen|überprüfen|ergänzen|bestätigen|einfügen|eintragen|klären|nachtragen|fehlt|offen)',
	'(?:platzhalter|hinweis|anmerkung|notiz)',
];

const REVIEWER_NOTE = new RegExp(
	`^(?:${REVIEWER_NOTE_OPENINGS.join('|')})(?![\\p{L}\\p{N}])`,
	'iu'
);

/**
 * A single-bracket span on one line: not half of a `[[...]]` placeholder, not
 * a markdown link `[text](url)` or reference `[text][1]`.
 */
const SINGLE_BRACKET = /(?<!\[)\[([^[\]\n]{1,400})\](?![[\]()])/gu;

/** {@link markReviewerNotes} for one line. Quoted lines are left alone. */
function markLine(line: string): string {
	if (line.trimStart().startsWith('>')) return line;
	return line.replace(SINGLE_BRACKET, (span, content: string) =>
		REVIEWER_NOTE.test(content.trim()) ? formatDraftGap(content) : span
	);
}

/**
 * Rewrite each single-bracket reviewer note in a draft (`[Bitte prüfen: ...]`,
 * `[Please confirm: ...]`, `[TODO ...]`) into a `[[...]]` placeholder, so the
 * composer and the send guard count it. Only a bracket that opens like a
 * reviewer note changes: `[1]` references, markdown links, `[EXTERNAL]` tags
 * and the quoted original keep their text.
 */
export function markReviewerNotes(text: string): string {
	const split = splitQuotedText(text);
	const fresh = split.fresh.split('\n').map(markLine).join('\n');
	return split.hasQuote ? `${fresh}\n${split.quoted}` : fresh;
}
