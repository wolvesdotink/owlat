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
