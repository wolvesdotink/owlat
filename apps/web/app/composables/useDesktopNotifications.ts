import { api } from '@owlat/api';
import { setupNotificationActionRouting } from '~/lib/desktop/notificationActions.client';

/**
 * Desktop-only native notifications and dock/taskbar badge.
 *
 * The badge tracks the caller's own **Postbox inbox unread** count (the
 * affordance every native mail client exposes) and fires a native "New mail"
 * notification when it rises — a single new message shows the sender + subject
 * with an **Archive** action (macOS/Linux; clicking it or the notification is
 * routed via the `notification-action` event), many shows a count. The AI
 * shared-inbox review queue is surfaced as a *separate*, clearly-labeled
 * notification — it never drives the badge.
 *
 * No-op in the browser (the `@owlat/desktop` import throws and is swallowed).
 */
export function useDesktopNotifications() {
	const { isDesktop } = useDesktopContext();
	const convex = requireConvex();

	// Route notification clicks / Archive actions → focus + deep-link / triage.
	onMounted(() => {
		if (isDesktop.value) void setupNotificationActionRouting(convex);
	});

	const previousUnread = ref<number | null>(null);
	const previousReviewQueue = ref<number | null>(null);

	// Personal inbox unread → badge + new-mail toast. Returns a plain number, so
	// there is no field name to drift (the original badge-always-0 bug).
	const { data: inboxUnread } = useConvexQuery(
		api.mail.mailbox.inboxUnreadCount,
		() => (isDesktop.value ? {} : 'skip'),
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

	/** A single new message shows its sender + subject with an Archive action;
	 * many shows a count. */
	async function fireNewMail(notif: DesktopNotif, delta: number) {
		if (delta === 1) {
			const latest = await convex.query(api.mail.mailbox.latestInboxUnread, {});
			if (latest) {
				await notif.sendActionableNotification(
					latest.fromName || latest.fromAddress,
					latest.subject || '(no subject)',
					latest.messageId,
					'inbox',
				);
				return;
			}
		}
		await notif.sendDesktopNotification(
			'New mail',
			delta === 1 ? 'You have 1 new message' : `You have ${delta} new messages`,
		);
	}

	watch(
		() => inboxUnread.value,
		async (raw) => {
			if (!isDesktop.value) return;
			const unread = typeof raw === 'number' ? raw : 0;
			try {
				const notif = await loadDesktopNotifications();
				await notif.updateTrayBadge(unread);
				if (previousUnread.value !== null && unread > previousUnread.value) {
					await fireNewMail(notif, unread - previousUnread.value);
				}
			} catch {
				// Tauri modules unavailable — running in the browser.
			}
			previousUnread.value = unread;
		},
		{ immediate: true },
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
