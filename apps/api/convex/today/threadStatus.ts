/**
 * One status per conversation row, highest priority wins.
 *
 * The sidebar (and Today) never shows two pills on a row. Pure and
 * framework-free so the ordering stays pinned by unit tests; the web mirrors
 * the same priority list for team-inbox rows it derives client-side.
 */

export type ThreadStatus = 'draft_ready' | 'needs_you' | 'updated' | 'waiting';

/** Lower index = more urgent. */
export const THREAD_STATUS_PRIORITY: readonly ThreadStatus[] = [
	'draft_ready',
	'needs_you',
	'updated',
	'waiting',
];

export interface ThreadStatusInput {
	needsReply?: {
		draftSlot?: unknown;
		clarification?: { draft?: unknown } | null;
	} | null;
	followUp?: { dueAt?: number } | null;
	/** Messages that arrived after the viewer's own last visit. */
	newSinceVisit: number;
}

export function deriveThreadStatus(input: ThreadStatusInput): ThreadStatus | null {
	const flag = input.needsReply;
	if (flag && (flag.draftSlot || flag.clarification?.draft)) return 'draft_ready';
	if (flag) return 'needs_you';
	if (input.followUp?.dueAt !== undefined) return 'needs_you';
	if (input.newSinceVisit > 0) return 'updated';
	if (input.followUp) return 'waiting';
	return null;
}

/** The most urgent status in a set (for a collapsed group or "Show more"). */
export function mostUrgentStatus(
	statuses: ReadonlyArray<ThreadStatus | null | undefined>
): ThreadStatus | null {
	let best: ThreadStatus | null = null;
	for (const status of statuses) {
		if (!status) continue;
		if (
			best === null ||
			THREAD_STATUS_PRIORITY.indexOf(status) < THREAD_STATUS_PRIORITY.indexOf(best)
		) {
			best = status;
		}
	}
	return best;
}

/** Categories Today files away behind a count instead of listing. */
export const FILED_CATEGORIES = [
	'newsletter',
	'notification',
	'receipt',
	'promotion',
	'spam',
] as const;
export type FiledCategory = (typeof FILED_CATEGORIES)[number];

export function isFiledCategory(label: string | undefined): label is FiledCategory {
	return !!label && (FILED_CATEGORIES as readonly string[]).includes(label);
}
