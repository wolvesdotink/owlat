/**
 * Pure partition logic for the Postbox Today view (the focused inbox landing
 * surface): split the flat inbox feed into
 *
 *   - `today`     — rows the landing view shows: received since LOCAL
 *                   midnight, plus anything still unread from the previous
 *                   local day (yesterday's unfinished business stays in
 *                   sight).
 *   - `autoFiled` — messages that WOULD be Today rows but whose thread
 *                   carries an auto-filed smart-inbox category (newsletter /
 *                   notification / receipt). They never render as Today
 *                   rows; one quiet roll-up line summarises them instead.
 *   - `older`     — everything else, behind the "Show past mails" affordance.
 *                   Category does not hide older mail: past mail is for
 *                   browsing, so nothing is ever lost there.
 *
 * Timezone-aware via plain local-time Date math (setHours/setDate), so DST
 * transitions and the user's own midnight are handled by the runtime, not by
 * fixed 24h offsets. Free of Convex/Vue so the boundaries are unit-testable.
 */

export type PostboxAutoFiledCategory = 'newsletter' | 'notification' | 'receipt';

/** Smart-inbox categories the Today view rolls up instead of listing. */
export const POSTBOX_AUTO_FILED_CATEGORIES: ReadonlySet<string> = new Set([
	'newsletter',
	'notification',
	'receipt',
] satisfies PostboxAutoFiledCategory[]);

/** Local midnight of the day containing `now`, as epoch ms. */
export function startOfLocalDay(now: Date): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** Local midnight of the day BEFORE the one containing `now` (DST-safe). */
export function startOfPreviousLocalDay(now: Date): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - 1);
	return d.getTime();
}

/** The projection the partition needs — a subset of the thread-row message. */
export interface PostboxTodayPartitionMessage {
	_id: string;
	receivedAt: number;
	flagSeen: boolean;
	threadId?: string;
}

export interface PostboxTodayPartition<T> {
	today: T[];
	older: T[];
	autoFiled: T[];
	/** Per-category tally of `autoFiled`, for the roll-up line. */
	autoFiledCounts: Partial<Record<PostboxAutoFiledCategory, number>>;
}

/**
 * Partition the (newest-first) inbox feed for the Today view. `categoryOf`
 * supplies the advisory smart-inbox category for a row (usually via its
 * thread); rows without a category are never auto-filed — fail-open, so
 * nothing disappears before the classifier has run.
 */
export function partitionTodayMessages<T extends PostboxTodayPartitionMessage>(
	messages: readonly T[],
	opts: { now: Date; categoryOf?: (message: T) => string | undefined }
): PostboxTodayPartition<T> {
	const todayStart = startOfLocalDay(opts.now);
	const yesterdayStart = startOfPreviousLocalDay(opts.now);
	const today: T[] = [];
	const older: T[] = [];
	const autoFiled: T[] = [];
	const autoFiledCounts: Partial<Record<PostboxAutoFiledCategory, number>> = {};

	for (const message of messages) {
		const isTodayCandidate =
			message.receivedAt >= todayStart ||
			(!message.flagSeen && message.receivedAt >= yesterdayStart);
		if (!isTodayCandidate) {
			older.push(message);
			continue;
		}
		const category = opts.categoryOf?.(message);
		if (category !== undefined && POSTBOX_AUTO_FILED_CATEGORIES.has(category)) {
			autoFiled.push(message);
			const key = category as PostboxAutoFiledCategory;
			autoFiledCounts[key] = (autoFiledCounts[key] ?? 0) + 1;
		} else {
			today.push(message);
		}
	}

	return { today, older, autoFiled, autoFiledCounts };
}

/** Fixed display order + nouns for the roll-up line. */
const AUTO_FILED_NOUNS: ReadonlyArray<{
	key: PostboxAutoFiledCategory;
	singular: string;
	plural: string;
}> = [
	{ key: 'newsletter', singular: 'newsletter', plural: 'newsletters' },
	{ key: 'notification', singular: 'notification', plural: 'notifications' },
	{ key: 'receipt', singular: 'receipt', plural: 'receipts' },
];

/**
 * Human roll-up line for auto-filed mail, e.g. "12 newsletters & receipts
 * auto-filed" or "1 notification auto-filed". Null when nothing was filed —
 * the view simply omits the line then.
 */
export function formatAutoFiledLine(
	counts: Partial<Record<PostboxAutoFiledCategory, number>>
): string | null {
	const present = AUTO_FILED_NOUNS.filter((noun) => (counts[noun.key] ?? 0) > 0);
	const total = present.reduce((sum, noun) => sum + (counts[noun.key] ?? 0), 0);
	if (total === 0) return null;
	const nouns = present.map((noun) => (total === 1 ? noun.singular : noun.plural));
	const list =
		nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(', ')} & ${nouns[nouns.length - 1]}`;
	return `${total} ${list} auto-filed`;
}
