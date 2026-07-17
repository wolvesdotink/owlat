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
	groupBody,
	newlyArrived,
	planNotifications,
	shouldNotify,
	NOTIFICATION_GROUP_WINDOW_MS,
	type ThreadWindowEntry,
	type UnreadPeekMessage,
} from '~/lib/desktop/notificationRules';

/**
 * Desktop-only native notifications and the app-icon unread badge.
 *
 * Driven by `mail.mailbox.newestUnreadInbox`, which returns the exact unread
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
 * The AI shared-inbox review queue is surfaced as a *separate*, clearly-labeled
 * notification — it never drives the badge or the peek. All notification
 * content is plain text. No-op in the browser (the `@owlat/desktop` import
 * throws and is swallowed).
 */
export function useDesktopNotifications() {
	const { isDesktop } = useDesktopContext();
	const convex = requireConvex();
	const { notifyAbout, badgeNonPeople } = usePostboxSettings();
	const { showToast } = useToast();

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

	// Route notification clicks / Archive / Mark read actions → focus + triage.
	onMounted(() => {
		if (isDesktop.value) void setupNotificationActionRouting(convex);
	});

	// Ids we've already accounted for (seeded silently on first load so we never
	// toast the existing backlog). Bounded so it can't grow without limit.
	const seenUnreadIds = new Set<string>();
	let loadedOnce = false;
	// Per-thread grouping memory (non-reactive — pure bookkeeping).
	let threadWindows = new Map<string, ThreadWindowEntry>();
	const previousReviewQueue = ref<number | null>(null);

	// Personal inbox unread window → badge + toast.
	const { data: unreadData } = useConvexQuery(api.mail.mailbox.newestUnreadInbox, () =>
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

	/** Fire the planned toasts (single = sender+subject, group = "N new from X").
	 * Both are actionable so Archive / Mark read / click work off the message. */
	async function firePlanned(
		notif: DesktopNotif,
		messages: UnreadPeekMessage[],
		now: number
	): Promise<void> {
		const fresh = newlyArrived(messages, seenUnreadIds);
		if (fresh.length === 0) return;
		const eligible = fresh.filter((m) => shouldNotify(m.category, notifyAbout.value));
		const plan = planNotifications(eligible, threadWindows, now, NOTIFICATION_GROUP_WINDOW_MS);
		threadWindows = plan.threadWindows;
		for (const n of plan.notifications) {
			if (n.kind === 'single') {
				await notif.sendActionableNotification(
					n.message.fromName || n.message.fromAddress,
					n.message.subject || '(no subject)',
					n.message.messageId,
					'inbox'
				);
			} else {
				await notif.sendActionableNotification(
					'New mail',
					groupBody(n.count, n.sender),
					n.sample.messageId,
					'inbox'
				);
			}
		}
	}

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
				if (loadedOnce && toastsAllowed.value) await firePlanned(notif, messages, now);
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
					previousReviewQueue.value !== null &&
					reviewQueue > previousReviewQueue.value
				) {
					const delta = reviewQueue - previousReviewQueue.value;
					await sendDesktopNotification(
						'Drafts ready for review',
						delta === 1
							? '1 new draft is ready for your review'
							: `${delta} new drafts are ready for your review`
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
				isDesktop.value && notifyAbout.value !== 'nothing' && toastsAllowed.value;
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
					showToast(assignmentToastMessage(plan.notice), 'success', {
						action: {
							label: 'Open',
							onAction: () => void navigateTo(`/dashboard/inbox/${threadId}`),
						},
					});
					if (notif) {
						const parts = assignmentNotificationParts(plan.notice);
						try {
							await notif.sendDesktopNotification(parts.title, parts.body);
						} catch {
							// Tauri modules unavailable.
						}
					}
				} else {
					showToast(assignmentGroupToastMessage(plan.count), 'success', {
						action: {
							label: 'Open',
							onAction: () => void navigateTo('/dashboard/inbox?filter=mine'),
						},
					});
					if (notif) {
						const parts = assignmentGroupNotificationParts(plan.count);
						try {
							await notif.sendDesktopNotification(parts.title, parts.body);
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
