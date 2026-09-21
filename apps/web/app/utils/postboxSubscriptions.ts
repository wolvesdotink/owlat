/**
 * Subscriptions panel — the pure half.
 *
 * Volume/last-read presentation and the batch-result summary. Module scope
 * never calls `useI18n`, so everything user-visible comes back as a
 * `{ key, params }` pair the component resolves with `t()`.
 */

/** One sender row, as `api.mail.subscriptions.list` returns it. */
export interface PostboxSubscriptionSender {
	senderEmail: string;
	senderName?: string;
	messageCount: number;
	unreadCount: number;
	lastReceivedAt: number;
	lastReadAt: number | null;
	method: 'one-click' | 'http' | 'mailto';
	httpUrl?: string;
	mailtoUrl?: string;
}

/** One sender's outcome, as `unsubscribeAndArchive` returns it. */
export interface PostboxSubscriptionOutcome {
	senderEmail: string;
	status: 'unsubscribed' | 'failed' | 'manual' | 'not_found';
	archived: number;
	error?: string;
	httpUrl?: string;
	mailtoUrl?: string;
}

const LAST_READ = 'shared.postboxSubscriptions.lastRead';

const DAY_MS = 86_400_000;

/**
 * The "last opened" column. Deliberately coarse — the underlying signal is the
 * arrival time of the newest message from this sender that has been read, so
 * "6 months ago" is honest where "14:03 on 3 March" would not be.
 *
 * `null` is the loudest cell in the table: nothing from this sender was ever
 * opened, which is the whole reason the panel exists.
 */
export function subscriptionLastReadMessage(
	lastReadAt: number | null,
	now: number = Date.now()
): { key: string; params: { count: number } } {
	if (lastReadAt === null) return { key: `${LAST_READ}.never`, params: { count: 0 } };
	const days = Math.floor((now - lastReadAt) / DAY_MS);
	if (days < 1) return { key: `${LAST_READ}.today`, params: { count: 0 } };
	if (days < 30) return { key: `${LAST_READ}.days`, params: { count: days } };
	const months = Math.floor(days / 30);
	if (months < 12) return { key: `${LAST_READ}.months`, params: { count: months } };
	return { key: `${LAST_READ}.years`, params: { count: Math.floor(days / 365) } };
}

/**
 * Which senders the batch verb can actually finish on its own. Only RFC 8058
 * One-Click can be performed server-side; the rest need the user on the
 * sender's page or in a composer, so the button must not promise them.
 */
export function selectableSubscriptionSenders(
	senders: readonly PostboxSubscriptionSender[],
	selected: ReadonlySet<string>
): { oneClick: string[]; manual: string[] } {
	const oneClick: string[] = [];
	const manual: string[] = [];
	for (const sender of senders) {
		if (!selected.has(sender.senderEmail)) continue;
		if (sender.method === 'one-click') oneClick.push(sender.senderEmail);
		else manual.push(sender.senderEmail);
	}
	return { oneClick, manual };
}

export interface PostboxSubscriptionBatchSummary {
	unsubscribed: number;
	failed: number;
	manual: number;
	notFound: number;
	archived: number;
}

/** Roll a batch up into the counts the summary line reads from. */
export function summarizeSubscriptionBatch(
	results: readonly PostboxSubscriptionOutcome[]
): PostboxSubscriptionBatchSummary {
	const summary: PostboxSubscriptionBatchSummary = {
		unsubscribed: 0,
		failed: 0,
		manual: 0,
		notFound: 0,
		archived: 0,
	};
	for (const result of results) {
		summary.archived += result.archived;
		if (result.status === 'unsubscribed') summary.unsubscribed += 1;
		else if (result.status === 'failed') summary.failed += 1;
		else if (result.status === 'manual') summary.manual += 1;
		else summary.notFound += 1;
	}
	return summary;
}

const SUMMARY = 'shared.postboxSubscriptions.summary';

export interface PostboxSubscriptionSummaryLine {
	key: string;
	count: number;
}

/**
 * The summary over a finished batch, as one line per thing that happened.
 *
 * Deliberately not a single interpolated sentence: a partial failure is the
 * normal outcome here (plenty of senders publish a List-Unsubscribe page but no
 * One-Click endpoint), and "3 unsubscribed / 148 archived / 1 needs finishing
 * on its own page" is the honest report. A lone red "something went wrong"
 * would hide which senders still want attention — and each line pluralizes on
 * its own count, which one sentence with four numbers in it cannot do.
 */
export function subscriptionBatchSummary(summary: PostboxSubscriptionBatchSummary): {
	tone: 'success' | 'warning' | 'error';
	lines: PostboxSubscriptionSummaryLine[];
} {
	const unfinished = summary.failed + summary.manual + summary.notFound;
	const lines: PostboxSubscriptionSummaryLine[] =
		summary.unsubscribed > 0
			? [{ key: `${SUMMARY}.unsubscribed`, count: summary.unsubscribed }]
			: [{ key: `${SUMMARY}.noneDone`, count: 0 }];
	if (summary.archived > 0) lines.push({ key: `${SUMMARY}.archived`, count: summary.archived });
	if (summary.failed > 0) lines.push({ key: `${SUMMARY}.failed`, count: summary.failed });
	if (summary.manual > 0) lines.push({ key: `${SUMMARY}.manual`, count: summary.manual });
	if (summary.notFound > 0) lines.push({ key: `${SUMMARY}.notFound`, count: summary.notFound });

	const tone = summary.unsubscribed === 0 ? 'error' : unfinished > 0 ? 'warning' : 'success';
	return { tone, lines };
}
