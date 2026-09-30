/**
 * The Answer queue's merged order — one queue over three sources:
 *
 *   - `mail`    a Postbox thread that needs a reply (any inbox the viewer reads),
 *   - `team`    a team-inbox agent draft waiting for approval (owners/admins),
 *   - `mention` a chat mention waiting on the viewer.
 *
 * Mail keeps its own server-computed priority score (sender importance ×
 * urgency, see utils/postboxReplyQueue.ts). The other two sit at fixed points
 * on the same scale: an agent draft someone outside is waiting on ranks just
 * above ordinary mail, a teammate's question just above ordinary mail too, and
 * below anything marked urgent. Ties go to whoever has waited longest.
 *
 * Pure so the interleaving is unit-testable.
 */
import { compareReplyQueueItems, type ReplyQueueItem } from './postboxReplyQueue';

/** Scale points for the non-mail sources (mail: low 20 · normal 50 · high 100). */
export const TEAM_DRAFT_SCORE = 60;
export const MENTION_SCORE = 55;

export type AnswerSource = 'mail' | 'team' | 'mention';

/**
 * How many team drafts and mentions the queue reads. The list (Answer, Today)
 * and the shell's count badge pass the same limits, so the badge counts what
 * the list shows.
 */
export const ANSWER_REVIEW_LIMIT = 50;
export const ANSWER_MENTION_LIMIT = 25;

export interface AnswerOrderInput {
	source: AnswerSource;
	/** When the thing started waiting (message received / mention created). */
	at: number;
	/** Mail rows only: the reply-queue row (drives score + urgency fallback). */
	row?: Pick<ReplyQueueItem, 'urgency' | 'priorityScore' | 'receivedAt'>;
}

function score(input: AnswerOrderInput): number {
	if (input.source === 'team') return TEAM_DRAFT_SCORE;
	if (input.source === 'mention') return MENTION_SCORE;
	return 0; // mail is compared with its own comparator below
}

export function compareAnswerItems(a: AnswerOrderInput, b: AnswerOrderInput): number {
	if (a.source === 'mail' && b.source === 'mail' && a.row && b.row) {
		return compareReplyQueueItems(a.row, b.row);
	}
	const scoreOf = (x: AnswerOrderInput) =>
		x.source === 'mail' && x.row
			? (x.row.priorityScore ?? { high: 100, normal: 50, low: 20 }[x.row.urgency])
			: score(x);
	const byScore = scoreOf(b) - scoreOf(a);
	if (byScore !== 0) return byScore;
	return a.at - b.at;
}

/**
 * The `?in=` filter on the Answer queue: `all`, `team` (the team inbox),
 * `chat` (mentions) or a mailbox id. This is how every "review these" link
 * lands on the one queue already narrowed — the Team inbox's "Review drafts"
 * button and the retired `/dashboard/inbox/review` route both open `?in=team`.
 */
export function parseAnswerFilter(raw: unknown): string {
	return typeof raw === 'string' && raw.length > 0 ? raw : 'all';
}

export function answerItemMatches(
	item: { source: AnswerSource; mailboxId?: string },
	filter: string
): boolean {
	if (filter === 'all') return true;
	if (filter === 'team') return item.source === 'team';
	if (filter === 'chat') return item.source === 'mention';
	return item.source === 'mail' && item.mailboxId === filter;
}

// The queue on Answer mode (plan §07)
// Opening the queue opens Answer mode on its first item; the queue steps from
// item to item by replacing the route. An Answer mode route the queue drives
// carries `?queue=<filter>` (the same values as `?in=`), so a reload lands back
// in the queue on the same item.

/** Where an item is answered: a Postbox message or a Team inbox thread. */
export type AnswerModeTarget =
	| { kind: 'mail'; messageId: string }
	| { kind: 'team'; threadId: string; messageId: string };

/** The slice of an Answer queue item the routing reads. */
export type AnswerRoutable =
	| { source: 'mail'; row: { kind?: string; messageId: string } }
	| { source: 'team'; entry: { message: { _id: string }; thread: { _id: string } | null } }
	| { source: 'mention' };

/**
 * Where Answer mode answers `item`: a Postbox row's message, a team draft's
 * thread. Null for a chat mention and a team draft whose thread is gone.
 */
export function answerModeTarget(item: AnswerRoutable): AnswerModeTarget | null {
	if (item.source === 'mail') return { kind: 'mail', messageId: item.row.messageId };
	if (item.source === 'team') {
		const thread = item.entry.thread;
		return thread
			? { kind: 'team', threadId: thread._id, messageId: item.entry.message._id }
			: null;
	}
	return null;
}

/**
 * Does the queue open `item` in Answer mode, or show it as a card on the queue
 * page? A follow-up reminder stays a card: we are waiting on them, and its one
 * verb is Done (writing a nudge opens Answer mode from the card).
 */
export function opensInAnswerMode(item: AnswerRoutable): boolean {
	if (item.source === 'mail' && item.row.kind === 'followup') return false;
	return answerModeTarget(item) !== null;
}

/** The Answer mode route of `target` while the queue (filtered to `filter`) drives it. */
export function answerQueueItemHref(target: AnswerModeTarget, filter: string): string {
	const queue = `queue=${encodeURIComponent(filter)}`;
	if (target.kind === 'mail') {
		return `/dashboard/answer/m/${encodeURIComponent(target.messageId)}?${queue}`;
	}
	return `/dashboard/answer/t/${encodeURIComponent(target.threadId)}?message=${encodeURIComponent(
		target.messageId
	)}&${queue}`;
}

/** The queue page itself, filtered to `filter`. */
export function answerQueueIndexHref(filter: string): string {
	return filter === 'all'
		? '/dashboard/answer'
		: `/dashboard/answer?in=${encodeURIComponent(filter)}`;
}

/**
 * Does `target` name the Answer mode page at `path` (with its `message`
 * query)? A Postbox route names the message; a team route names the thread,
 * and the message too when the URL picked one.
 */
export function answerTargetMatchesRoute(
	target: AnswerModeTarget,
	route: { path: string; query: Record<string, unknown> }
): boolean {
	if (target.kind === 'mail') {
		return route.path === `/dashboard/answer/m/${encodeURIComponent(target.messageId)}`;
	}
	if (route.path !== `/dashboard/answer/t/${encodeURIComponent(target.threadId)}`) return false;
	const message = route.query['message'];
	return typeof message !== 'string' || message === target.messageId;
}
