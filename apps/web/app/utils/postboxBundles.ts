/**
 * Bundled inbox feed — collapse runs of low-signal mail into one row.
 *
 * The category classifier already labels every thread (person / newsletter /
 * notification / receipt), and the flat inbox ignores that entirely: twelve
 * newsletters still cost twelve rows and twelve decisions. This module folds a
 * RUN of consecutive non-person rows into one expandable row per category —
 * "Newsletters · 12, latest from Northwind Digest" — with the whole run's ids
 * attached so the bundle can be archived or unsubscribed from in one action.
 *
 * Two properties make it safe to ship as a view mode rather than a change to
 * the flat list:
 *
 *   - It is a pure re-shaping of the feed the flat list already has. No new
 *     query, no server work, nothing hidden: every message in a bundle is one
 *     disclosure away, and the bundle states its own count.
 *   - Only CONSECUTIVE non-person rows fold. A newsletter sitting between two
 *     replies stays exactly where the arrival order put it, so the feed's
 *     chronology is never rearranged — a bundle is a run, not a filter.
 *
 * An unclassified row (`category` absent — the classifier has not run, or is
 * off) counts as person-like and never folds. Fail-open: the cost of leaving a
 * newsletter in the list is one row; the cost of folding away a real reply is
 * a missed message.
 */

/** Categories that fold. `person` and anything unlabeled never do. */
export const POSTBOX_BUNDLE_CATEGORIES = ['newsletter', 'notification', 'receipt'] as const;

export type PostboxBundleCategory = (typeof POSTBOX_BUNDLE_CATEGORIES)[number];

/**
 * The shortest run worth folding. Two: one row folded into one bundle row
 * saves nothing and costs a disclosure, and at three the list starts hiding
 * pairs people would rather just see.
 */
export const POSTBOX_BUNDLE_MIN_SIZE = 2;

/** Icon + label KEY per bundle category (module scope never calls `useI18n`). */
export const POSTBOX_BUNDLE_META: Record<PostboxBundleCategory, { label: string; icon: string }> = {
	newsletter: { label: 'shared.postboxBundles.newsletter', icon: 'lucide:newspaper' },
	notification: { label: 'shared.postboxBundles.notification', icon: 'lucide:bell' },
	receipt: { label: 'shared.postboxBundles.receipt', icon: 'lucide:receipt' },
};

function isBundleCategory(value: string | undefined): value is PostboxBundleCategory {
	return value !== undefined && (POSTBOX_BUNDLE_CATEGORIES as readonly string[]).includes(value);
}

/** The projection the grouping needs — a subset of the thread-row message. */
export interface PostboxBundleMessage {
	_id: string;
	threadId?: string;
	fromAddress: string;
	fromName?: string;
	flagSeen: boolean;
	unsubscribe?: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
}

export interface PostboxBundle<T> {
	/**
	 * Stable enough to key the expanded/collapsed state on: new mail arrives at
	 * the head of the feed, so a bundle further down keeps both its category and
	 * its first message as rows are added above it.
	 */
	id: string;
	category: PostboxBundleCategory;
	messages: T[];
	/** How many rows this one row stands for. */
	count: number;
	/** Display name of the newest message in the bundle ("latest from …"). */
	latestFrom: string;
	/** Unread rows inside, so a bundle never hides an unread count. */
	unreadCount: number;
}

export type PostboxFeedEntry<T> =
	| { kind: 'message'; message: T }
	| ({ kind: 'bundle' } & PostboxBundle<T>);

/** How a sender reads on the bundle's "latest from" line. */
function displayName(message: PostboxBundleMessage): string {
	return message.fromName?.trim() || message.fromAddress;
}

/**
 * Fold the feed. `categoryOf` supplies the advisory smart-inbox category for a
 * row (usually via its thread); the feed order is preserved exactly, and every
 * message appears in the output exactly once — either as its own row or inside
 * one bundle.
 */
export function bundlePostboxFeed<T extends PostboxBundleMessage>(
	messages: readonly T[],
	options: { categoryOf?: (message: T) => string | undefined; minSize?: number } = {}
): Array<PostboxFeedEntry<T>> {
	const minSize = options.minSize ?? POSTBOX_BUNDLE_MIN_SIZE;
	const entries: Array<PostboxFeedEntry<T>> = [];
	let run: T[] = [];

	/**
	 * Close the current run: bucket it by category in first-appearance order,
	 * emit each bucket that reached `minSize` as a bundle and every other row
	 * as itself, IN THE ORDER THE RUN'S FIRST MEMBERS APPEARED. A bundle
	 * therefore sits where its first message sat, so the run's own chronology
	 * survives the fold.
	 */
	function flushRun() {
		if (run.length === 0) return;
		const buckets = new Map<PostboxBundleCategory, T[]>();
		const loose: Array<{ index: number; message: T }> = [];
		for (const [index, message] of run.entries()) {
			const category = options.categoryOf?.(message);
			if (!isBundleCategory(category)) {
				loose.push({ index, message });
				continue;
			}
			const bucket = buckets.get(category);
			if (bucket) bucket.push(message);
			else buckets.set(category, [message]);
		}

		const emitted: Array<{ index: number; entry: PostboxFeedEntry<T> }> = loose.map(
			({ index, message }) => ({ index, entry: { kind: 'message', message } })
		);
		for (const [category, bucket] of buckets) {
			const firstIndex = run.indexOf(bucket[0]!);
			if (bucket.length < minSize) {
				for (const message of bucket) {
					emitted.push({ index: run.indexOf(message), entry: { kind: 'message', message } });
				}
				continue;
			}
			emitted.push({
				index: firstIndex,
				entry: {
					kind: 'bundle',
					id: `${category}:${bucket[0]!._id}`,
					category,
					messages: bucket,
					count: bucket.length,
					latestFrom: displayName(bucket[0]!),
					unreadCount: bucket.filter((message) => !message.flagSeen).length,
				},
			});
		}
		emitted.sort((a, b) => a.index - b.index);
		for (const { entry } of emitted) entries.push(entry);
		run = [];
	}

	for (const message of messages) {
		const category = options.categoryOf?.(message);
		if (isBundleCategory(category)) {
			run.push(message);
			continue;
		}
		flushRun();
		entries.push({ kind: 'message', message });
	}
	flushRun();
	return entries;
}

/**
 * The senders in a bundle whose mail carried an RFC 8058 one-click
 * unsubscribe, deduplicated and lowercased.
 *
 * One-click ONLY: it is the sole method a batch can actually perform without a
 * browser (`mail/subscriptions.unsubscribeAndArchive`). A sender with a plain
 * web page needs a human on that page, and promising to unsubscribe them from
 * a bundle row would be a lie.
 */
export function bundleOneClickSenders(messages: readonly PostboxBundleMessage[]): string[] {
	const senders = new Set<string>();
	for (const message of messages) {
		if (message.unsubscribe?.oneClick) senders.add(message.fromAddress.trim().toLowerCase());
	}
	return [...senders];
}

/** Every message id in a bundle — what the bulk archive acts on. */
export function bundleMessageIds(messages: readonly PostboxBundleMessage[]): string[] {
	return messages.map((message) => message._id);
}
