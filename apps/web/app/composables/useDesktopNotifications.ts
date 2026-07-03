import { api } from '@owlat/api';
import { setupNotificationActionRouting } from '~/lib/desktop/notificationActions.client';
import {
	badgeCount,
	groupBody,
	newlyArrived,
	planNotifications,
	shouldNotify,
	trayPeekItems,
	NOTIFICATION_GROUP_WINDOW_MS,
	type ThreadWindowEntry,
	type UnreadPeekMessage,
} from '~/lib/desktop/notificationRules';

/**
 * Desktop-only native notifications, dock/taskbar badge, and tray quick-peek.
 *
 * Driven by `mail.mailbox.newestUnreadInbox`, which returns the exact unread
 * `total` plus a bounded newest-first window of unread messages. From that we:
 *
 *   - keep the dock/tray **badge** truthful (the affordance every native mail
 *     client exposes) — optionally counting only `person` mail when the user
 *     opts non-people mail out of the badge;
 *   - fire a native **toast** for genuinely new mail, honoring the user's
 *     "Notify me about" scope (Everything / People & important / Nothing) and
 *     **grouping** repeat arrivals in one thread within a short window into a
 *     single "N new messages from X" toast instead of a stack;
 *   - refresh the **tray quick-peek** dropdown listing the ~5 newest unread.
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

	// Personal inbox unread window → badge + toast + tray peek.
	const { data: unreadData } = useConvexQuery(
		api.mail.mailbox.newestUnreadInbox,
		() => (isDesktop.value ? { limit: 5 } : 'skip'),
	);

	// AI shared-inbox review queue (admin-only; null otherwise) → labeled toast.
	const { data: inboundStats } = useConvexQuery(
		api.inbox.queries.getInboundStats,
		() => (isDesktop.value ? {} : 'skip'),
	);

	function loadDesktopNotifications() {
		return import('@owlat/desktop/src/notifications');
	}
	type DesktopNotif = Awaited<ReturnType<typeof loadDesktopNotifications>>;

	/** Fire the planned toasts (single = sender+subject, group = "N new from X").
	 * Both are actionable so Archive / Mark read / click work off the message. */
	async function firePlanned(
		notif: DesktopNotif,
		messages: UnreadPeekMessage[],
		now: number,
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
					'inbox',
				);
			} else {
				await notif.sendActionableNotification(
					'New mail',
					groupBody(n.count, n.sender),
					n.sample.messageId,
					'inbox',
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
				await notif.updateTrayBadge(badgeCount(total, messages, badgeNonPeople.value));
				await notif.updateTrayPeek(trayPeekItems(messages));
				if (loadedOnce) await firePlanned(notif, messages, now);
			} catch {
				// Tauri modules unavailable — running in the browser.
			}
			rememberSeen(messages);
			loadedOnce = true;
		},
		{ immediate: true, deep: true },
	);

	watch(
		() => inboundStats.value,
		async (stats) => {
			if (!isDesktop.value || !stats) return;
			const reviewQueue = (stats as { draftReady?: number }).draftReady ?? 0;
			try {
				const { sendDesktopNotification } = await loadDesktopNotifications();
				if (previousReviewQueue.value !== null && reviewQueue > previousReviewQueue.value) {
					const delta = reviewQueue - previousReviewQueue.value;
					await sendDesktopNotification(
						'Drafts ready for review',
						delta === 1
							? '1 new draft is ready for your review'
							: `${delta} new drafts are ready for your review`,
					);
				}
			} catch {
				// Tauri modules unavailable.
			}
			previousReviewQueue.value = reviewQueue;
		},
		{ deep: true },
	);

	return { isDesktop };
}
