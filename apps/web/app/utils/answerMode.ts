/**
 * Answer mode's address book: the route every Postbox reply opens, and the
 * small pure rules the page and its entry points share.
 *
 * A reply is a route, not an overlay (plan decision 1), so a reload, a
 * notification deep link and the desktop window all land in the same state:
 *
 *   /dashboard/answer/m/<mailMessageId>?kind=reply|replyAll|forward&draft=<id>
 *
 * `draft` resumes a saved draft. Without it the page builds a fresh composer of
 * `kind`; an absent `kind` means the person's primary reply (their default
 * reply mode), which is what `r` and the Reply button ask for.
 */

export const ANSWER_MODE_KINDS = ['reply', 'replyAll', 'forward'] as const;
export type AnswerModeKind = (typeof ANSWER_MODE_KINDS)[number];

/** The route prefix of Answer mode for Postbox mail. */
const ANSWER_MAIL_PREFIX = '/dashboard/answer/m/';
/** The route prefix of Answer mode for a Team inbox thread. */
const ANSWER_TEAM_PREFIX = '/dashboard/answer/t/';

/** A `?kind=` value, or null when it is absent or not one of the three verbs. */
export function parseAnswerKind(raw: unknown): AnswerModeKind | null {
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === 'string' && (ANSWER_MODE_KINDS as readonly string[]).includes(value)
		? (value as AnswerModeKind)
		: null;
}

/** A single string route param/query value, or null. */
export function singleQueryValue(raw: unknown): string | null {
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Where Answer mode for `messageId` lives, with the composer kind and draft to open. */
export function answerModeHref(
	messageId: string,
	opts: { kind?: AnswerModeKind | null; draftId?: string | null } = {}
): string {
	const params = new URLSearchParams();
	if (opts.kind) params.set('kind', opts.kind);
	if (opts.draftId) params.set('draft', opts.draftId);
	const query = params.toString();
	return `${ANSWER_MAIL_PREFIX}${encodeURIComponent(messageId)}${query ? `?${query}` : ''}`;
}

/**
 * Where Answer mode for the Team inbox thread `threadId` lives. `message` picks
 * the inbound message the reply answers when it is not the one the thread
 * would pick itself (an older message that also holds a waiting draft).
 */
export function answerTeamHref(threadId: string, opts: { messageId?: string | null } = {}): string {
	const query = opts.messageId ? `?message=${encodeURIComponent(opts.messageId)}` : '';
	return `${ANSWER_TEAM_PREFIX}${encodeURIComponent(threadId)}${query}`;
}

/** True on an Answer mode route (a reply being written), not on the queue index. */
export function isAnswerModePath(path: string): boolean {
	return path.startsWith(ANSWER_MAIL_PREFIX) || path.startsWith(ANSWER_TEAM_PREFIX);
}

/**
 * Whether a reply draft holds anything the person wrote: text outside the
 * quoted original and the signature, or an attachment. The composer seeds a
 * reply with the quote (and a signature), so "the body is not empty" would be
 * true of every reply ever opened; this is the test the "Draft saved · Resume"
 * bar needs, since leaving an untouched reply must not claim a draft was saved.
 */
export function answerDraftHasContent(bodyHtml: string, attachmentCount: number): boolean {
	if (attachmentCount > 0) return true;
	if (!bodyHtml) return false;
	if (typeof DOMParser === 'undefined') {
		return bodyHtml.replace(/<[^>]+>/g, '').trim().length > 0;
	}
	const doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
	for (const el of doc.body.querySelectorAll('.gmail_quote, [data-postbox-signature]')) {
		el.remove();
	}
	return (doc.body.textContent ?? '').replace(/​/g, '').trim().length > 0;
}

/** True when a reply/forward body carries the quoted original the composer folds. */
export function bodyHasQuote(bodyHtml: string): boolean {
	return bodyHtml.includes('gmail_quote');
}

/**
 * Where Esc goes from the Answer mode route `path` when no page to return to
 * was recorded (a deep link, a reload, a notification): the list the reply
 * belongs to, the Team inbox for a team thread and the Postbox otherwise.
 */
export function answerFallbackReturn(path: string): string {
	return path.startsWith(ANSWER_TEAM_PREFIX) ? '/dashboard/inbox' : '/dashboard/postbox/inbox';
}

/**
 * The catalog key of the back link's place ("Team inbox", "Answer queue"),
 * named after the page a reply returns to.
 */
export function answerBackLabelKey(returnPath: string): string {
	if (returnPath.startsWith('/dashboard/postbox')) return 'components.answer.mode.backTo.inbox';
	if (returnPath.startsWith('/dashboard/inbox')) return 'components.answer.mode.backTo.teamInbox';
	if (returnPath.startsWith('/dashboard/answer')) return 'components.answer.mode.backTo.queue';
	if (returnPath === '/dashboard' || returnPath.startsWith('/dashboard?')) {
		return 'components.answer.mode.backTo.workbench';
	}
	return 'components.answer.mode.backTo.previous';
}
