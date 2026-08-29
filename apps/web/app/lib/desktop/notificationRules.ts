/**
 * Pure, side-effect-free rules for desktop mail notifications. Extracted from
 * `useDesktopNotifications` so the category-x-setting toast matrix, the
 * badge sub-setting, the per-thread grouping window, the quiet-hours window
 * (with its "while you were away" roll-up), the per-thread reply alert and the
 * hide-preview copy are all unit-testable without a running Tauri bridge or a
 * live Convex subscription.
 *
 * Nothing here touches the DOM, Tauri, or the network — the composable feeds it
 * plain data and executes the returned plan.
 */
import type { PostboxMailCategory, PostboxNotifyAbout } from '~/utils/postboxNotify';
import type { PostboxQuietHours } from '~/utils/postboxQuietHours';
import { isQuietHoursArmed, MINUTES_PER_DAY } from '~/utils/postboxQuietHours';

/** One unread inbox message as returned by `mail.mailbox.queries.newestUnreadInbox`. */
export interface UnreadPeekMessage {
	messageId: string;
	threadId: string;
	fromName?: string;
	fromAddress: string;
	subject: string;
	category?: PostboxMailCategory;
	/** The message's thread is MUTED (mail/mute.ts) — never toast it. */
	muted?: boolean;
	/**
	 * The message's thread is armed with "notify me when they reply"
	 * (mail/threadAlerts.ts) — it pierces the people-only scope AND quiet hours.
	 */
	alerted?: boolean;
	receivedAt: number;
}

/**
 * Should a NEW message of this category fire a toast under the chosen scope?
 *
 *   - a MUTED thread    → never, whatever the scope says. Mute is an explicit
 *     per-conversation opt-out, so it outranks the notification setting (and,
 *     unlike category, it is never a guess).
 *   - 'nothing'          → never.
 *   - 'everything'       → always.
 *   - 'people-important' → only `person`. A message whose category is still
 *     absent (classifier hasn't run) falls open so nothing is silently dropped
 *     before classification.
 */
export function shouldNotify(
	category: PostboxMailCategory | undefined,
	setting: PostboxNotifyAbout,
	muted = false
): boolean {
	if (muted) return false;
	if (setting === 'nothing') return false;
	if (setting === 'everything') return true;
	// people-important
	return category === undefined || category === 'person';
}

/**
 * Is `at` (a LOCAL wall-clock instant on the user's device) inside the quiet
 * window? False for an inert window — off, no weekday selected, or zero-length.
 *
 * A window whose end is at or before its start wraps midnight, and the weekday
 * mask names the day the window STARTS on: with Friday masked, 22:00 → 07:00
 * covers Friday night AND Saturday until 07:00, which is what "quiet on Friday
 * night" means to a person.
 */
export function isWithinQuietHours(q: PostboxQuietHours | undefined, at: Date): boolean {
	if (!q || !isQuietHoursArmed(q)) return false;
	const minutes = at.getHours() * 60 + at.getMinutes();
	const day = at.getDay();
	if (q.startMinute < q.endMinute) {
		// Same-day window (09:00 → 17:00): start inclusive, end exclusive.
		return q.days.includes(day) && minutes >= q.startMinute && minutes < q.endMinute;
	}
	// Wrapping window (22:00 → 07:00): the tail belongs to the PREVIOUS day's mask.
	if (minutes >= q.startMinute) return q.days.includes(day);
	if (minutes < q.endMinute) return q.days.includes((day + 6) % 7);
	return false;
}

/**
 * Minutes from `at` until the current quiet window ends, or null when `at` is
 * not inside one. Lets the composable schedule the "while you were away"
 * summary instead of waiting for the next piece of mail to notice.
 */
export function minutesUntilQuietHoursEnd(
	q: PostboxQuietHours | undefined,
	at: Date
): number | null {
	if (!isWithinQuietHours(q, at) || !q) return null;
	const minutes = at.getHours() * 60 + at.getMinutes();
	const delta = q.endMinute - minutes;
	return delta > 0 ? delta : delta + MINUTES_PER_DAY;
}

/** Why a toast did not fire, or null when it did. */
export type NotificationSuppression = 'muted' | 'scope' | 'quiet-hours' | null;

export interface NotifyDecisionInput {
	category?: PostboxMailCategory;
	setting: PostboxNotifyAbout;
	/** The thread is muted (mail/mute.ts). */
	muted?: boolean;
	/** The thread is armed with "notify me when they reply". */
	alerted?: boolean;
	/** We are currently inside the user's quiet-hours window. */
	quiet?: boolean;
}

/**
 * The whole per-message decision in one place, in precedence order:
 *
 *   1. MUTED wins over everything, including an armed alert — the two are kept
 *      mutually exclusive server-side, so a thread carrying both is stale data
 *      and the quieter reading is the safe one.
 *   2. An ARMED thread ("notify me when they reply") fires regardless of scope
 *      and regardless of quiet hours. That is the entire point of arming it:
 *      one conversation the user explicitly asked to be interrupted for.
 *   3. The global SCOPE (Everything / People & important / Nothing).
 *   4. QUIET HOURS suppress what is left — and, unlike the cases above, those
 *      toasts are counted so they can be rolled into one summary at the end of
 *      the window rather than silently dropped.
 */
export function decideNotification(input: NotifyDecisionInput): {
	fire: boolean;
	suppressed: NotificationSuppression;
} {
	if (input.muted) return { fire: false, suppressed: 'muted' };
	if (input.alerted) return { fire: true, suppressed: null };
	if (!shouldNotify(input.category, input.setting)) return { fire: false, suppressed: 'scope' };
	if (input.quiet) return { fire: false, suppressed: 'quiet-hours' };
	return { fire: true, suppressed: null };
}

/** Quiet-hours bookkeeping carried between ticks (non-reactive, pure data). */
export interface QuietHoursState {
	/** Were we inside the window at the previous tick? */
	quiet: boolean;
	/** Toasts held back by the window and not yet summarized. */
	deferred: number;
}

export const QUIET_HOURS_INITIAL_STATE: QuietHoursState = { quiet: false, deferred: 0 };

/**
 * Advance the quiet-hours bookkeeping by one tick.
 *
 * While the window is open, newly suppressed toasts accumulate. The first tick
 * after it closes returns the accumulated count as `summaryCount` and resets —
 * that is the single "N while you were away" notification, and it is emitted
 * exactly once because the counter is cleared in the same step.
 *
 * Suppressed toasts that arrive on a tick where the window is already closed
 * (a clock jump, a settings change mid-flight) are still counted into the
 * summary rather than lost.
 */
export function stepQuietHours(
	prev: QuietHoursState,
	tick: { quiet: boolean; suppressed: number }
): { state: QuietHoursState; summaryCount: number } {
	const deferred = prev.deferred + Math.max(0, tick.suppressed);
	if (tick.quiet) return { state: { quiet: true, deferred }, summaryCount: 0 };
	return { state: { quiet: false, deferred: 0 }, summaryCount: deferred };
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
	badgeNonPeople: boolean
): number {
	if (badgeNonPeople) return total;
	const people = messages.filter((m) => m.category === undefined || m.category === 'person').length;
	return Math.min(people, total);
}

/**
 * The subset of `current` unread messages that are newly arrived relative to
 * the `seen` id set — i.e. candidates for a toast this tick.
 */
export function newlyArrived(
	current: UnreadPeekMessage[],
	seen: ReadonlySet<string>
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
	  }
	/** The one roll-up fired when a quiet-hours window closes. */
	| { kind: 'quiet-summary'; count: number };

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
	windowMs: number
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
 * Copy produced by these rules: either LITERAL text that came from the mail
 * itself (a sender name, a subject — never translatable) or a message KEY
 * resolved at the render boundary. Tagged rather than a bare `string | {key}`
 * union precisely because a subject like "Nothing" must not be mistaken for a
 * catalog lookup. This module is Vue-free, so it never calls `t` itself.
 */
export type NoticeText =
	| { text: string }
	| { key: string; params?: Record<string, string | number> };

/** Everything the composable needs to fire one planned notification. */
export interface NotificationParts {
	title: NoticeText;
	body: NoticeText;
	/**
	 * The message the notification's Archive / Mark read / click actions address.
	 * Absent for the quiet-hours summary, which is about no single message and is
	 * therefore sent as a plain notification.
	 */
	messageId?: string;
}

const KEY_PREFIX = 'shared.useDesktopNotifications';

/**
 * Title + body for a planned notification, honoring the "hide message preview"
 * preference: with previews hidden nothing from the mail itself reaches the OS
 * notification — no sender, no subject, no count per sender — only a generic
 * localized "New message" line, so a shared or projected screen leaks nothing.
 * All notification content is plain text; never HTML.
 */
export function notificationParts(n: PlannedNotification, hidePreview = false): NotificationParts {
	if (n.kind === 'quiet-summary') {
		return {
			title: { key: `${KEY_PREFIX}.quietSummary.title` },
			body: { key: `${KEY_PREFIX}.quietSummary.body`, params: { count: n.count } },
		};
	}
	if (n.kind === 'group') {
		return {
			title: { key: `${KEY_PREFIX}.newMail` },
			body: hidePreview
				? { key: `${KEY_PREFIX}.hiddenPreview.group`, params: { count: n.count } }
				: { key: `${KEY_PREFIX}.groupBody`, params: { count: n.count, sender: n.sender } },
			messageId: n.sample.messageId,
		};
	}
	const m = n.message;
	if (hidePreview) {
		return {
			title: { key: `${KEY_PREFIX}.newMail` },
			body: { key: `${KEY_PREFIX}.hiddenPreview.single` },
			messageId: m.messageId,
		};
	}
	return {
		title: { text: m.fromName || m.fromAddress },
		body: m.subject ? { text: m.subject } : { key: `${KEY_PREFIX}.noSubject` },
		messageId: m.messageId,
	};
}
