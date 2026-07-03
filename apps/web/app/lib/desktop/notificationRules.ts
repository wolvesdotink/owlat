/**
 * Pure, side-effect-free rules for desktop mail notifications. Extracted from
 * `useDesktopNotifications` so the category-x-setting toast matrix, the
 * badge sub-setting, and the per-thread grouping window are unit-testable
 * without a running Tauri bridge or a live Convex subscription.
 *
 * Nothing here touches the DOM, Tauri, or the network — the composable feeds it
 * plain data and executes the returned plan.
 */
import type {
	PostboxMailCategory,
	PostboxNotifyAbout,
} from '~/utils/postboxNotify';

/** One unread inbox message as returned by `mail.mailbox.newestUnreadInbox`. */
export interface UnreadPeekMessage {
	messageId: string;
	threadId: string;
	fromName?: string;
	fromAddress: string;
	subject: string;
	category?: PostboxMailCategory;
	receivedAt: number;
}

/**
 * Should a NEW message of this category fire a toast under the chosen scope?
 *
 *   - 'nothing'          → never.
 *   - 'everything'       → always.
 *   - 'people-important' → only `person`. A message whose category is still
 *     absent (classifier hasn't run) falls open so nothing is silently dropped
 *     before classification.
 */
export function shouldNotify(
	category: PostboxMailCategory | undefined,
	setting: PostboxNotifyAbout,
): boolean {
	if (setting === 'nothing') return false;
	if (setting === 'everything') return true;
	// people-important
	return category === undefined || category === 'person';
}

/**
 * The badge value to display. Defaults to the exact server `total`. When the
 * user opts non-`person` mail OUT of the badge (`badgeNonPeople === false`),
 * fall back to counting only the `person` messages in the bounded peek window
 * (best-effort: mail whose category is absent counts as a person so the badge
 * never under-reports un-classified new mail). Never exceeds `total`.
 */
export function badgeCount(
	total: number,
	messages: UnreadPeekMessage[],
	badgeNonPeople: boolean,
): number {
	if (badgeNonPeople) return total;
	const people = messages.filter(
		(m) => m.category === undefined || m.category === 'person',
	).length;
	return Math.min(people, total);
}

/**
 * The subset of `current` unread messages that are newly arrived relative to
 * the `seen` id set — i.e. candidates for a toast this tick.
 */
export function newlyArrived(
	current: UnreadPeekMessage[],
	seen: ReadonlySet<string>,
): UnreadPeekMessage[] {
	return current.filter((m) => !seen.has(m.messageId));
}

/** A planned notification the composable turns into a Tauri call. */
export type PlannedNotification =
	| { kind: 'single'; message: UnreadPeekMessage }
	| {
			kind: 'group';
			threadId: string;
			sender: string;
			count: number;
			sample: UnreadPeekMessage;
	  };

/** Per-thread grouping memory: how many were bundled and when last fired. */
export interface ThreadWindowEntry {
	count: number;
	sender: string;
	lastAt: number;
}

export interface PlanResult {
	notifications: PlannedNotification[];
	/** Updated grouping memory (old entries outside the window are pruned). */
	threadWindows: Map<string, ThreadWindowEntry>;
}

function senderOf(m: UnreadPeekMessage): string {
	return m.fromName || m.fromAddress;
}

function newestOf(msgs: UnreadPeekMessage[]): UnreadPeekMessage {
	return msgs.reduce((a, b) => (b.receivedAt > a.receivedAt ? b : a));
}

/**
 * Group newly-arrived messages by thread and collapse repeats within a short
 * window into a single updated "N new from X" notification.
 *
 * `newMessages` are this tick's fresh arrivals (already category-filtered by
 * the caller). Two or more in the same thread — either in this batch or within
 * `windowMs` of a prior notification for that thread — produce one `group`
 * notification carrying the cumulative count; a lone new message in a fresh
 * thread produces a `single`. The returned `threadWindows` carries the memory
 * forward (with entries older than `windowMs` pruned).
 */
export function planNotifications(
	newMessages: UnreadPeekMessage[],
	threadWindows: ReadonlyMap<string, ThreadWindowEntry>,
	now: number,
	windowMs: number,
): PlanResult {
	// Preserve prior entries so a still-open window keeps accumulating; prune
	// stale ones so memory can't grow unbounded.
	const next = new Map<string, ThreadWindowEntry>();
	for (const [threadId, entry] of threadWindows) {
		if (now - entry.lastAt <= windowMs) next.set(threadId, entry);
	}

	const byThread = new Map<string, UnreadPeekMessage[]>();
	for (const m of newMessages) {
		const list = byThread.get(m.threadId);
		if (list) list.push(m);
		else byThread.set(m.threadId, [m]);
	}

	const notifications: PlannedNotification[] = [];
	for (const [threadId, msgs] of byThread) {
		const prior = next.get(threadId);
		const withinWindow = prior !== undefined && now - prior.lastAt <= windowMs;
		const priorCount = withinWindow ? prior.count : 0;
		const total = priorCount + msgs.length;
		const sample = newestOf(msgs);
		const sender = senderOf(sample);
		if (total > 1) {
			notifications.push({ kind: 'group', threadId, sender, count: total, sample });
		} else {
			notifications.push({ kind: 'single', message: sample });
		}
		next.set(threadId, { count: total, sender, lastAt: now });
	}

	return { notifications, threadWindows: next };
}

/** Default grouping window: repeats in a thread within 30s collapse. */
export const NOTIFICATION_GROUP_WINDOW_MS = 30_000;

/**
 * Plain-text body for a grouped notification ("3 new messages from Anna").
 * All notification content is plain text — never HTML.
 */
export function groupBody(count: number, sender: string): string {
	return `${count} new messages from ${sender}`;
}

/** One row in the tray quick-peek dropdown. Plain text only. */
export interface TrayPeekItem {
	messageId: string;
	folderRole: string;
	title: string;
}

function truncate(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Map the newest-unread peek window to tray menu rows: "Sender — Subject",
 * clamped to `limit` (≈5) and to a short label length so the native menu stays
 * compact. Clicking a row opens that thread in the inbox via the existing
 * action routing (folderRole 'inbox').
 */
export function trayPeekItems(
	messages: UnreadPeekMessage[],
	limit = 5,
): TrayPeekItem[] {
	return messages.slice(0, limit).map((m) => {
		const sender = truncate(senderOf(m), 28);
		const subject = truncate(m.subject || '(no subject)', 40);
		return { messageId: m.messageId, folderRole: 'inbox', title: `${sender} — ${subject}` };
	});
}
