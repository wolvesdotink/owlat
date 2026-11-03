/**
 * The team stream's paging rules, pure.
 *
 * A team thread is read as one stream: customer emails, the team's replies,
 * internal notes and activity system lines, in one order with keys that stay
 * the same across pages. Each source is read on its own and merged with the
 * keyset rules in `lib/keysetMerge.ts`, re-exported here for the stream's
 * readers; what follows is the stream's own vocabulary.
 *
 * Isolate-safe, no Convex functions.
 */

export {
	chainRanges,
	compareStreamPositions,
	decodeStreamCursor,
	encodeStreamCursor,
	isBefore,
	isOnPage,
	mergeStreamPage,
	rangesBefore,
	readSourceBatch,
} from '../../lib/keysetMerge';
export type { MergedPage, SourceBatch, StreamPosition } from '../../lib/keysetMerge';

/**
 * Activity rows the stream shows as system lines: substance only, and not
 * the ones a bubble already shows (an email arriving, a reply going out).
 */
const BUBBLE_ACTIVITY = new Set(['message_received', 'reply_sent', 'auto_sent']);

export function isStreamActivity(row: { type: string; visibility: string }): boolean {
	return row.visibility === 'substance' && !BUBBLE_ACTIVITY.has(row.type);
}

/** A Send's status as the stream shows a team reply. */
export function teamReplyStatusOf(status: string): 'queued' | 'sent' | 'failed' {
	if (status === 'queued') return 'queued';
	if (status === 'failed' || status === 'bounced') return 'failed';
	return 'sent';
}

/** A Postbox outbound row's recipients as one status. */
export function outboundStatusOf(
	recipients: readonly { state: 'queued' | 'sent' | 'bounced' | 'failed' }[]
): 'queued' | 'sent' | 'failed' {
	if (recipients.some((r) => r.state === 'bounced' || r.state === 'failed')) return 'failed';
	if (recipients.some((r) => r.state === 'queued')) return 'queued';
	return 'sent';
}

/** A short single-line preview of raw text. */
export function streamPreview(text: string | undefined, max = 280): string {
	const flat = (text ?? '').replace(/\s+/g, ' ').trim();
	if (flat.length <= max) return flat;
	return `${[...flat].slice(0, max - 1).join('')}…`;
}
