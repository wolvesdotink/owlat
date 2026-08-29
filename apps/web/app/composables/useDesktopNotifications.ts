import { api } from '@owlat/api';
import { setupNotificationActionRouting } from '~/lib/desktop/notificationActions.client';
import {
	assignmentGroupNotificationParts,
	assignmentGroupToastMessage,
	assignmentNotificationParts,
	assignmentToastMessage,
	planAssignmentNotices,
	type AssignmentNotice,
} from '~/lib/inbox/assignmentNoticeRules';
import {
	badgeCount,
	decideNotification,
	isWithinQuietHours,
	newlyArrived,
	notificationParts,
	planNotifications,
	stepQuietHours,
	NOTIFICATION_GROUP_WINDOW_MS,
	QUIET_HOURS_INITIAL_STATE,
	type NoticeText as NotificationNoticeText,
	type PlannedNotification,
	type QuietHoursState,
	type ThreadWindowEntry,
	type UnreadPeekMessage,
} from '~/lib/desktop/notificationRules';

/**
 * Desktop-only native notifications and the app-icon unread badge.
 *
 * Driven by `mail.mailbox.queries.newestUnreadInbox`, which returns the exact unread
 * `total` plus a bounded newest-first window of unread messages. From that we:
 *
 *   - keep the dock/taskbar **badge** truthful (the affordance every native mail
 *     client exposes) — optionally counting only `person` mail when the user
 *     opts non-people mail out of the badge;
 *   - fire a native **toast** for genuinely new mail, honoring the user's
 *     "Notify me about" scope (Everything / People & important / Nothing) and
 *     **grouping** repeat arrivals in one thread within a short window into a
 *     single "N new messages from X" toast instead of a stack.
 *
 * Three gates sit on top of the scope, all decided by the pure rules module:
 * a **quiet-hours** window (suppressed toasts are counted and roll into one
 * "N while you were away" notification when the window closes), a per-thread
 * **"notify me when they reply"** alert that pierces both quiet hours and the
 * people-only scope, and the **hide-preview** preference that replaces sender +
 * subject with a generic line. OS permission is checked (and requested once) up
 * front, so a first toast can no longer vanish unasked.
 *
 * The AI shared-inbox review queue is surfaced as a *separate*, clearly-labeled
 * notification — it never drives the badge or the peek. All notification
 * content is plain text. No-op in the browser (the `@owlat/desktop` import
 * throws and is swallowed).
 */
/** How often we re-check whether the quiet-hours window has closed. */
const QUIET_HOURS_POLL_MS = 60_000;

export function useDesktopNotifications() {
	const { isDesktop } = useDesktopContext();
	const convex = requireConvex();
	const { notifyAbout, badgeNonPeople, quietHours, hidePreview } = usePostboxSettings();
	const { canSend, request: requestNotificationPermission } = useDesktopNotificationPermission();
	const { showToast } = useToast();
	const { t } = useI18n();

	/**
	 * Copy produced by the pure notice rules: a message key, optionally with the
	 * values it interpolates. Resolved here — the rules modules are Vue-free.
	 */
	type NoticeText = string | { key: string; params?: Record<string, unknown> };
	const localize = (text: NoticeText): string =>
		typeof text === 'string' ? t(text) : t(text.key, text.params ?? {});

	/**
	 * Same job for the notification rules, whose copy is TAGGED: `{ text }` came
	 * out of the mail and is passed through verbatim, `{ key }` is a catalog
	 * lookup. A numeric `count` param also selects the plural form, so "1 new
	 * message" and "4 new messages" both read correctly.
	 */
	const localizeNotification = (part: NotificationNoticeText): string => {
		if ('text' in part) return part.text;
		const params = part.params ?? {};
		const count = params['count'];
		return typeof count === 'number' ? t(part.key, params, count) : t(part.key, params);
	};

	// Device-scoped gates from /desktop/settings: a global master switch, an
	// unread-badge toggle, and a per-workspace mute — all layered on top of the
	// server-side "Notify me about" scope handled in the rules above.
	const { settings: appSettings, workspaceLocal } = useDesktopAppSettings();
	const { activeId } = useDesktopWorkspaces();
	const toastsAllowed = computed(
		() =>
			appSettings.value.global.notificationsEnabled &&
			!(activeId.value ? workspaceLocal(activeId.value).muteNotifications : false)
	);

	// Route notification clicks / Archive / Mark read actions → focus + triage,
	// and settle the OS permission before the first toast would need it (the app
	// used to call .show() from Rust without ever asking).
	onMounted(() => {
		if (!isDesktop.value) return;
		void setupNotificationActionRouting(convex);
		void requestNotificationPermission();
	});

	// Ids we've already accounted for (seeded silently on first load so we never
	// toast the existing backlog). Bounded so it can't grow without limit.
	const seenUnreadIds = new Set<string>();
	let loadedOnce = false;
	// Per-thread grouping memory (non-reactive — pure bookkeeping).
	let threadWindows = new Map<string, ThreadWindowEntry>();
	// Quiet-hours bookkeeping: were we inside the window, and how many toasts it
	// has swallowed since. Also non-reactive — nothing renders it.
	let quietState: QuietHoursState = QUIET_HOURS_INITIAL_STATE;
	const previousReviewQueue = ref<number | null>(null);

	// Personal inbox unread window → badge + toast.
	const { data: unreadData } = useConvexQuery(api.mail.mailbox.queries.newestUnreadInbox, () =>
		isDesktop.value ? { limit: 5 } : 'skip'
	);

	// AI shared-inbox review queue (admin-only; null otherwise) → labeled toast.
	const { data: inboundStats } = useConvexQuery(api.inbox.queries.getInboundStats, () =>
		isDesktop.value ? {} : 'skip'
	);

	// "Assigned to you" notices for the current user. Runs in EVERY session (not
	// desktop-gated) so the in-app toast lands in the browser too; the desktop
	// notification path is gated below. Empty for non-admins server-side.
	const { data: assignmentData } = useConvexQuery(api.inbox.queries.pendingAssignments, () => ({}));
	const seenAssignmentIds = new Set<string>();
	let loadedAssignmentsOnce = false;

	function loadDesktopNotifications() {
		return import('@owlat/desktop/src/notifications');
	}
	type DesktopNotif = Awaited<ReturnType<typeof loadDesktopNotifications>>;

	/**
	 * Send one planned notification. Mail-addressed ones stay actionable (so
	 * Archive / Mark read / click work off the message); the quiet-hours summary
	 * is about no single message and goes out plain.
	 */
	async function fireOne(notif: DesktopNotif, n: PlannedNotification): Promise<void> {
		const parts = notificationParts(n, hidePreview.value);
		const title = localizeNotification(parts.title);
		const body = localizeNotification(parts.body);
		if (parts.messageId) {
			await notif.sendActionableNotification(title, body, parts.messageId, 'inbox');
		} else {
			await notif.sendDesktopNotification(title, body);
		}
	}

	/**
	 * Decide, plan and fire this tick's toasts (single = sender+subject, group =
	 * "N new from X"), plus the roll-up when a quiet-hours window has just
	 * closed. Everything the decision needs is passed to the pure rules; this
	 * only resolves copy and talks to Tauri.
	 */
	async function firePlanned(
		notif: DesktopNotif,
		messages: UnreadPeekMessage[],
		now: number
	): Promise<void> {
		const fresh = newlyArrived(messages, seenUnreadIds);
		const quiet = isWithinQuietHours(quietHours.value, new Date(now));
		const eligible: UnreadPeekMessage[] = [];
		let deferred = 0;
		for (const m of fresh) {
			const decision = decideNotification({
				category: m.category,
				setting: notifyAbout.value,
				muted: m.muted,
				alerted: m.alerted,
				quiet,
			});
			if (decision.fire) eligible.push(m);
			// Only quiet hours DEFER a toast; a muted thread or an out-of-scope
			// category is a decision, not a delay, and never enters the summary.
			else if (decision.suppressed === 'quiet-hours') deferred += 1;
		}
		const stepped = stepQuietHours(quietState, { quiet, suppressed: deferred });
		quietState = stepped.state;
		const plan = planNotifications(eligible, threadWindows, now, NOTIFICATION_GROUP_WINDOW_MS);
		threadWindows = plan.threadWindows;
		for (const n of plan.notifications) await fireOne(notif, n);
		if (stepped.summaryCount > 0) {
			await fireOne(notif, { kind: 'quiet-summary', count: stepped.summaryCount });
		}
	}

	/**
	 * The summary has to land when the WINDOW closes, and mail arriving is what
	 * drives every other tick — a quiet night that ends at 07:00 with nothing new
	 * would otherwise hold its count until the next message. So poll the clock
	 * once a minute and flush through the same pure step.
	 */
	async function flushQuietHours(): Promise<void> {
		const stepped = stepQuietHours(quietState, {
			quiet: isWithinQuietHours(quietHours.value, new Date()),
			suppressed: 0,
		});
		quietState = stepped.state;
		if (stepped.summaryCount === 0 || !toastsAllowed.value || !canSend.value) return;
		try {
			const notif = await loadDesktopNotifications();
			await fireOne(notif, { kind: 'quiet-summary', count: stepped.summaryCount });
		} catch {
			// Tauri modules unavailable — running in the browser.
		}
	}

	// Client-only by construction: onMounted never runs during SSR.
	let quietTimer: ReturnType<typeof setInterval> | null = null;
	onMounted(() => {
		if (!isDesktop.value) return;
		quietTimer = setInterval(() => void flushQuietHours(), QUIET_HOURS_POLL_MS);
	});
	onUnmounted(() => {
		if (quietTimer !== null) clearInterval(quietTimer);
		quietTimer = null;
	});

	function rememberSeen(messages: UnreadPeekMessage[]): void {
		for (const m of messages) seenUnreadIds.add(m.messageId);
		if (seenUnreadIds.size > 1000) {
			seenUnreadIds.clear();
			for (const m of messages) seenUnreadIds.add(m.messageId);
		}
	}

	watch(
		() => unreadData.value,
		async (data) => {
			if (!isDesktop.value || !data) return;
			const total = data.total;
			const messages = data.messages as UnreadPeekMessage[];
			const now = Date.now();
			try {
				const notif = await loadDesktopNotifications();
				// A disabled badge clears to 0 (not "skip the call") so a previously
				// painted count can't linger on the dock icon.
				await notif.updateUnreadBadge(
					appSettings.value.global.showUnreadBadge
						? badgeCount(total, messages, badgeNonPeople.value)
						: 0
				);
				// A refused OS permission blocks the send outright; every other
				// permission state (including "we couldn't tell") still tries.
				if (loadedOnce && toastsAllowed.value && canSend.value) {
					await firePlanned(notif, messages, now);
				}
			} catch {
				// Tauri modules unavailable — running in the browser.
			}
			rememberSeen(messages);
			loadedOnce = true;
		},
		{ immediate: true, deep: true }
	);

	// Repaint the badge when its toggle changes — the data watch above only
	// fires on unread changes, which could leave a stale count (or a stale
	// blank) on the dock icon until the next arrival.
	watch(
		() => appSettings.value.global.showUnreadBadge,
		async (show) => {
			if (!isDesktop.value) return;
			const data = unreadData.value;
			try {
				const notif = await loadDesktopNotifications();
				await notif.updateUnreadBadge(
					show && data
						? badgeCount(data.total, data.messages as UnreadPeekMessage[], badgeNonPeople.value)
						: 0
				);
			} catch {
				// Tauri modules unavailable.
			}
		}
	);

	watch(
		() => inboundStats.value,
		async (stats) => {
			if (!isDesktop.value || !stats) return;
			const reviewQueue = (stats as { draftReady?: number }).draftReady ?? 0;
			try {
				const { sendDesktopNotification } = await loadDesktopNotifications();
				if (
					toastsAllowed.value &&
					canSend.value &&
					previousReviewQueue.value !== null &&
					reviewQueue > previousReviewQueue.value
				) {
					const delta = reviewQueue - previousReviewQueue.value;
					await sendDesktopNotification(
						t('shared.useDesktopNotifications.draftsReady.title'),
						t('shared.useDesktopNotifications.draftsReady.body', { count: delta }, delta)
					);
				}
			} catch {
				// Tauri modules unavailable.
			}
			previousReviewQueue.value = reviewQueue;
		},
		{ deep: true }
	);

	// "Assigned to you" → in-app toast (always) + desktop notification (when the
	// user hasn't muted notifications). Bursts coalesce via planAssignmentNotices;
	// the first load seeds `seen` silently so we never toast the backlog.
	watch(
		() => assignmentData.value,
		async (rows) => {
			if (!rows) return;
			const notices = rows as AssignmentNotice[];
			if (!loadedAssignmentsOnce) {
				for (const n of notices) seenAssignmentIds.add(n.id);
				loadedAssignmentsOnce = true;
				return;
			}

			const plans = planAssignmentNotices(notices, seenAssignmentIds);
			for (const n of notices) seenAssignmentIds.add(n.id);
			if (seenAssignmentIds.size > 1000) {
				seenAssignmentIds.clear();
				for (const n of notices) seenAssignmentIds.add(n.id);
			}
			if (plans.length === 0) return;

			// Desktop notifications honor the user's notify scope ('nothing' mutes
			// them) AND the device-scoped toggles (global switch + workspace mute).
			// The in-app toast still shows either way — it's a foreground signal.
			const notifyDesktop =
				isDesktop.value && notifyAbout.value !== 'nothing' && toastsAllowed.value && canSend.value;
			let notif: DesktopNotif | null = null;
			if (notifyDesktop) {
				try {
					notif = await loadDesktopNotifications();
				} catch {
					notif = null;
				}
			}

			for (const plan of plans) {
				if (plan.kind === 'single') {
					const threadId = plan.notice.threadId;
					showToast(localize(assignmentToastMessage(plan.notice)), 'success', {
						action: {
							label: t('common.open'),
							onAction: () => void navigateTo(`/dashboard/inbox/${threadId}`),
						},
					});
					if (notif) {
						const parts = assignmentNotificationParts(plan.notice);
						try {
							await notif.sendDesktopNotification(localize(parts.title), localize(parts.body));
						} catch {
							// Tauri modules unavailable.
						}
					}
				} else {
					showToast(localize(assignmentGroupToastMessage(plan.count)), 'success', {
						action: {
							label: t('common.open'),
							onAction: () => void navigateTo('/dashboard/inbox?filter=mine'),
						},
					});
					if (notif) {
						const parts = assignmentGroupNotificationParts(plan.count);
						try {
							await notif.sendDesktopNotification(localize(parts.title), localize(parts.body));
						} catch {
							// Tauri modules unavailable.
						}
					}
				}
			}
		},
		{ immediate: true, deep: true }
	);

	return { isDesktop };
}
