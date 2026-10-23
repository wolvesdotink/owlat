import { api } from '@owlat/api';
import {
	freshMarketingNotices,
	presentMarketingNotice,
	type MarketingNoticeView,
	type NoticeText,
} from '~/lib/marketing/marketingNoticeRules';

/**
 * Marketing notices in the foreground: a campaign that finished or is about to
 * send, a delivery hold, a stalled or paused automation, a broken sending
 * domain record.
 *
 * Subscribes to `marketing.notifications.listRecent` in every session, so the
 * in-app toast lands in the browser and on the desktop alike; the desktop app
 * also shows a native notification, behind the same device switches as mail
 * (the master switch and the workspace mute) and the OS permission. The first
 * answer is seeded silently, so opening the app never replays a backlog. The
 * server already applied the person's switches, role and feature flags, and
 * dropped notices that no longer hold (a reminder for a campaign cancelled
 * meanwhile).
 *
 * The toast offers Open. A scheduled campaign's reminder opens the campaign,
 * where Cancel lives: cancelling is final, so it is never one click from a
 * toast. Web Push offers Open and Cancel on the notification itself; Cancel
 * opens the campaign with the confirmation up.
 */

/** How long the reminder stays up: it is about the next quarter of an hour. */
const REMINDER_TOAST_MS = 15_000;
/** Remembered ids before the set is re-seeded from the current answer. */
const MAX_SEEN = 500;

export function useMarketingNotices() {
	const { isDesktop } = useDesktopContext();
	const { showToast } = useToast();
	const { t } = useI18n();
	const { canSend } = useDesktopNotificationPermission();
	const { settings: appSettings, workspaceLocal } = useDesktopAppSettings();
	const { activeId } = useDesktopWorkspaces();

	const nativeAllowed = computed(
		() =>
			isDesktop.value &&
			canSend.value &&
			appSettings.value.global.notificationsEnabled &&
			!(activeId.value ? workspaceLocal(activeId.value).muteNotifications : false)
	);

	/** Resolve a catalog key; a `count` value also picks the plural form. */
	function resolve(text: NoticeText): string {
		const params: Record<string, string | number> = {};
		for (const [name, value] of Object.entries(text.params ?? {})) {
			params[name] = typeof value === 'object' ? t(value.key) : value;
		}
		const count = params['count'];
		return typeof count === 'number' ? t(text.key, params, count) : t(text.key, params);
	}

	async function notifyNative(title: string, body: string): Promise<void> {
		try {
			const { sendDesktopNotification } = await import('@owlat/desktop/src/notifications');
			await sendDesktopNotification(title, body);
		} catch {
			// Tauri modules unavailable: running in the browser.
		}
	}

	function surface(notice: MarketingNoticeView, now: number): void {
		const presentation = presentMarketingNotice(notice, now);
		const title = resolve(presentation.title);
		const body = resolve(presentation.body);
		showToast(t('shared.marketingNotices.toast', { title, body }), presentation.toastType, {
			...(notice.kind === 'campaign_reminder' ? { durationMs: REMINDER_TOAST_MS } : {}),
			action: {
				label: t('common.open'),
				onAction: () => void navigateTo(presentation.href),
			},
		});
		if (nativeAllowed.value) void notifyNative(title, body);
	}

	const { data } = useConvexQuery(api.marketing.notifications.listRecent, () => ({}));
	const seen = new Set<string>();
	let loadedOnce = false;

	watch(
		() => data.value,
		(rows) => {
			if (!rows) return;
			const notices = rows as MarketingNoticeView[];
			const fresh = loadedOnce ? freshMarketingNotices(notices, seen) : [];
			loadedOnce = true;
			if (seen.size + notices.length > MAX_SEEN) seen.clear();
			for (const notice of notices) seen.add(notice.id);
			const now = Date.now();
			for (const notice of fresh) surface(notice, now);
		},
		{ immediate: true }
	);
}
