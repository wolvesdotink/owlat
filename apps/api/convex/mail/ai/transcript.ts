/**
 * The one thread → prompt transcript builder for Postbox AI.
 *
 * Every feature that hands a mail thread to a model (summaries, suggested
 * replies, Ask, coach, Today sentences, draft-on-arrival, the clarification
 * draft, category and needs-reply classification) flattens it here, so the body
 * fallback, the side labels and the trimming rule cannot drift apart again.
 *
 * - Body: the inline text part when it has content, else the HTML part with
 *   tags stripped, else the stored snippet. HTML-only mail is common from
 *   business senders; without the fallback a classifier sees only the snippet.
 * - Side labels (`ownerAddress`): each message says whether the mailbox owner
 *   or the other party wrote it. Pass it wherever the output drafts a reply or
 *   decides one is needed: unlabelled, the model cannot tell our messages from
 *   theirs and happily drafts the other party's answer to what we wrote.
 * - Trigger (`triggerId`): the message being answered goes last, under
 *   {@link TRIGGER_MARKER}.
 * - Trimming: the OLDEST messages go first, so the newest message (or the
 *   trigger) always survives; the result is then hard-capped at `totalChars`.
 *
 * Deliberately NOT 'use node': draft-on-arrival, the clarification context,
 * category and needs-reply build their transcript inside a query. That is also
 * why the HTML fallback uses the runtime-neutral `htmlToPlainText` rather than
 * `mail/rfc822.ts`, which is a Node module.
 */

import { htmlToPlainText } from '@owlat/shared/html';
import { openMailMessageInlineBody } from '../../lib/messageBody';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import type { Doc, Id } from '../../_generated/dataModel';

/** Per-message body cap and whole-transcript cap, in characters. */
export interface TranscriptBudget {
	perMessageChars: number;
	totalChars: number;
}

/** Summaries, suggested replies, Ask, coach and Today sentences. */
export const THREAD_SUMMARY: TranscriptBudget = { perMessageChars: 4000, totalChars: 12000 };
/** Draft-on-arrival (mail/ai/draftOnArrivalStore.ts). */
export const DRAFT_ON_ARRIVAL: TranscriptBudget = { perMessageChars: 2000, totalChars: 12000 };
/** Answer mode "Draft with AI" (mail/ai/composeDraftStore.ts). */
export const ANSWER_DRAFT: TranscriptBudget = { perMessageChars: 2500, totalChars: 14000 };
/** The starter draft after a clarification is answered (mail/ai/needsReplyClarify.ts). */
export const CLARIFY_DRAFT: TranscriptBudget = { perMessageChars: 2000, totalChars: 12000 };
/** Category refinement (mail/category.ts). */
export const CATEGORY: TranscriptBudget = { perMessageChars: 1500, totalChars: 8000 };
/** Needs-reply classification and clarification (mail/needsReply.ts). */
export const NEEDS_REPLY: TranscriptBudget = { perMessageChars: 2000, totalChars: 12000 };

/** Heads the message a draft answers — always the last one in the transcript. */
export const TRIGGER_MARKER = '=== The message to reply to ===';

const SEPARATOR = '\n\n---\n\n';

export interface TranscriptOptions extends TranscriptBudget {
	/** Label each message as the mailbox owner's or the other party's. */
	ownerAddress?: string;
	/** Put this message last under {@link TRIGGER_MARKER}. Ignored when absent from `messages`. */
	triggerId?: Id<'mailMessages'>;
	/** Add a `To:` line per message. */
	includeTo?: boolean;
	/**
	 * Add an `Attachments:` line naming each message's files. Answer mode needs
	 * it to see what was already exchanged ("the invoice I sent last week");
	 * the other callers leave it off, so their prompts are unchanged.
	 */
	includeAttachments?: boolean;
}

/** Most attachment names listed for one message. */
const MAX_LISTED_ATTACHMENTS = 10;

/** The `Attachments:` line of one message, or '' when it has none. */
function attachmentLine(m: Doc<'mailMessages'>): string {
	const names = m.attachments
		.filter((a) => a.filename.trim().length > 0)
		.slice(0, MAX_LISTED_ATTACHMENTS)
		.map((a) => a.filename.trim().slice(0, 120));
	return names.length > 0 ? `\nAttachments: ${names.join(', ')}` : '';
}

/** The prompt body of one message: text part, else stripped HTML, else snippet. */
async function messageBody(m: Doc<'mailMessages'>): Promise<string> {
	const { text, html } = await openMailMessageInlineBody(m);
	if (text && text.trim()) return text;
	if (html) {
		const stripped = htmlToPlainText(html);
		if (stripped) return stripped;
	}
	return m.snippet ?? '';
}

/**
 * Flatten a thread into a bounded plaintext transcript. `messages` must be in
 * chronological order (oldest first); callers own the bounded read and the
 * ordering. Unseals each row's inline body through the accessor choke point.
 *
 * The rows must carry their inline bodies: a reader query's rows do
 * (`listThreadMessages`), rows straight from `ctx.db` do not since plan 3.2
 * moved bodies to `mailMessageBodies`, so pass those through
 * `withStoredInlineBodies(ctx.db, rows)` first. A row without one falls back
 * to its snippet.
 */
export async function buildThreadTranscript(
	messages: Doc<'mailMessages'>[],
	opts: TranscriptOptions
): Promise<string> {
	const render = async (m: Doc<'mailMessages'>): Promise<string> => {
		const sender = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
		const side =
			opts.ownerAddress === undefined
				? ''
				: isFromMailboxOwner(m, opts.ownerAddress)
					? ' — the mailbox owner (you)'
					: ' — the other party';
		const to = opts.includeTo ? `\nTo: ${m.toAddresses.join(', ')}` : '';
		const files = opts.includeAttachments ? attachmentLine(m) : '';
		const body = (await messageBody(m)).slice(0, opts.perMessageChars);
		return `From: ${sender}${side}${to}\nSubject: ${m.subject}${files}\n${body}`;
	};

	const trigger =
		opts.triggerId === undefined ? undefined : messages.find((m) => m._id === opts.triggerId);
	const history = trigger ? messages.filter((m) => m._id !== trigger._id) : messages;
	const earlier = await Promise.all(history.map(render));
	const last = trigger ? [`${TRIGGER_MARKER}\n${await render(trigger)}`] : [];

	// Drop the oldest messages until it fits, always keeping the newest one.
	let transcript = [...earlier, ...last].join(SEPARATOR);
	while (transcript.length > opts.totalChars && earlier.length + last.length > 1) {
		earlier.shift();
		transcript = [...earlier, ...last].join(SEPARATOR);
	}
	return transcript.slice(0, opts.totalChars);
}
