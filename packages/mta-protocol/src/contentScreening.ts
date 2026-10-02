/**
 * The Convex -> MTA `POST /scan/content` exchange: the campaign pre-send check
 * asks how the MTA's content screening would judge a rendered message, without
 * queueing anything.
 *
 * The verdict mirrors the dispatch phase (`apps/mta/src/intelligence/
 * contentScreening.ts`) step for step, minus the envelope checks a draft cannot
 * fail on its own (sender, subject presence, DKIM alignment): an empty body, the
 * size budget, the URL blocklist and, when rspamd is configured, its score.
 */

import { isRecord } from '@owlat/shared/utils/guards';

/** Largest HTML body either end accepts for a screening preview. */
export const CONTENT_SCREENING_MAX_HTML_BYTES = 2 * 1024 * 1024;

/** RFC 5322's line limit; a longer subject is not a subject. */
export const CONTENT_SCREENING_MAX_SUBJECT_CHARS = 998;

export interface MtaContentScreeningRequest {
	/** The From address the send would use; absent when none is chosen yet. */
	from?: string;
	subject: string;
	html: string;
}

/** Why screening would drop the message, in the dispatch phase's own order. */
export type MtaContentScreeningReason =
	| 'empty_body'
	| 'content_too_large'
	| 'blocked_url'
	| 'spam_score';

const REASONS: readonly MtaContentScreeningReason[] = [
	'empty_body',
	'content_too_large',
	'blocked_url',
	'spam_score',
];

export interface MtaContentScreeningVerdict {
	/** `CONTENT_SCREENING_ENABLED`: off means the MTA screens nothing at send time. */
	enabled: boolean;
	verdict: 'accept' | 'reject';
	reason?: MtaContentScreeningReason;
	/** The operator's blocklist pattern a link matched (`blocked_url` only). */
	blockedPattern?: string;
	/** `CONTENT_MAX_SIZE_KB`, the HTML budget screening enforces. */
	sizeLimitKb: number;
	/** rspamd's opinion, when it is configured and answered. */
	spam?: { score: number; threshold: number };
}

function isReason(value: unknown): value is MtaContentScreeningReason {
	return REASONS.some((reason) => reason === value);
}

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/** Validate an MTA answer; anything malformed reads as `null`. */
export function normalizeContentScreeningVerdict(
	value: unknown
): MtaContentScreeningVerdict | null {
	if (!isRecord(value)) return null;
	const { enabled, verdict, reason, blockedPattern, sizeLimitKb, spam } = value;
	if (typeof enabled !== 'boolean' || (verdict !== 'accept' && verdict !== 'reject')) return null;
	if (!isFiniteNumber(sizeLimitKb)) return null;
	const result: MtaContentScreeningVerdict = { enabled, verdict, sizeLimitKb };
	if (isReason(reason)) result.reason = reason;
	if (typeof blockedPattern === 'string' && blockedPattern.length <= 512) {
		result.blockedPattern = blockedPattern;
	}
	if (isRecord(spam) && isFiniteNumber(spam['score']) && isFiniteNumber(spam['threshold'])) {
		result.spam = { score: spam['score'], threshold: spam['threshold'] };
	}
	return result;
}
