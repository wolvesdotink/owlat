import { api } from '@owlat/api';
import { getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { isWithinQuietHours } from '~/lib/desktop/notificationRules';
import {
	freshMarketingNotices,
	isNativeNoticeCurrent,
	planQuietRelease,
	presentMarketingNotice,
	presentNativeMarketingNotice,
	type MarketingNoticeView,
	type NoticeText,
} from '~/lib/marketing/marketingNoticeRules';
import { resolveLocalized } from '~/utils/localizedText';

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
 * The native notification follows the person's notification settings like
 * Web Push does: private notifications keep names off it, and quiet hours hold
 * it back. What the window held goes out when it ends, if it still holds then
 * (see `planQuietRelease`). Clicking it opens the notice's page in the
 * workspace that sent it, through the desktop notification router.
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
/** How often a held-back notice is checked against the end of quiet hours. */
const QUIET_HOURS_POLL_MS = 60_000;

export function useMarketingNotices() {
	const { isDesktop } = useDesktopContext();
	const { showToast } = useToast();
	const { t, te } = useI18n();
	const { canSend } = useDesktopNotificationPermission();
	const { settings: appSettings, workspaceLocal } = useDesktopAppSettings();
	const { activeId } = useDesktopWorkspaces();
	const { quietHours, hidePreview } = usePostboxSettings();

	const nativeAllowed = computed(
		() =>
			isDesktop.value &&
			canSend.value &&
			appSettings.value.global.notificationsEnabled &&
			!(activeId.value ? workspaceLocal(activeId.value).muteNotifications : false)
	);

	/**
	 * Resolve a notice's copy. A value given as `{ key }` (a provider name) is
	 * itself looked up; a `count` value also picks the plural form, which the
	 * shared resolver has no argument for.
	 */
	function resolve(text: NoticeText): string {
		const params: Record<string, string | number> = {};
		if (text.params) {
			for (const [name, value] of Object.entries(text.params)) {
				params[name] = typeof value === 'object' ? resolveLocalized({ t, te }, value) : value;
			}
		}
		const count = params['count'];
		return typeof count === 'number'
			? t(text.key, params, count)
			: resolveLocalized({ t, te }, { key: text.key, params });
	}

	function isQuietAt(now: number): boolean {
		return isWithinQuietHours(quietHours.value, new Date(now));
	}

	/** One notice as an OS notification that opens its page when clicked. */
	async function notifyNative(notice: MarketingNoticeView, now: number): Promise<void> {
		const native = presentNativeMarketingNotice(notice, now, hidePreview.value);
		try {
			const { sendLinkNotification } = await import('@owlat/desktop/src/notifications');
			await sendLinkNotification(
				resolve(native.title),
				resolve(native.body),
				native.href,
				getActiveWorkspace()?.id
			);
		} catch {
			// Tauri modules unavailable: running in the browser.
		}
	}

	async function notifyHeldSummary(count: number): Promise<void> {
		try {
			const { sendDesktopNotification } = await import('@owlat/desktop/src/notifications');
			await sendDesktopNotification(
				t('shared.marketingNotices.quietSummary.title'),
				t('shared.marketingNotices.quietSummary.body', { count }, count)
			);
		} catch {
			// Tauri modules unavailable: running in the browser.
		}
	}

	/** Notices whose OS notification quiet hours held back. */
	let held = new Set<string>();

	/** Once the window has closed, send what was held and still holds. */
	function releaseHeld(now: number): void {
		if (held.size === 0 || isQuietAt(now)) return;
		const plan = planQuietRelease(held, (data.value ?? []) as MarketingNoticeView[], now);
		held = new Set();
		if (!nativeAllowed.value) return;
		if (plan.kind === 'single') void notifyNative(plan.notice, now);
		else if (plan.kind === 'summary') void notifyHeldSummary(plan.count);
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
		if (!nativeAllowed.value || !isNativeNoticeCurrent(notice, now)) return;
		if (isQuietAt(now)) held.add(notice.id);
		else void notifyNative(notice, now);
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
			releaseHeld(now);
			for (const notice of fresh) surface(notice, now);
		},
		{ immediate: true }
	);

	// The window has to be noticed closing when nothing new arrives, so the
	// clock is polled while something is held. Client-only: onMounted never
	// runs during SSR.
	let quietTimer: ReturnType<typeof setInterval> | null = null;
	onMounted(() => {
		if (!isDesktop.value) return;
		quietTimer = setInterval(() => releaseHeld(Date.now()), QUIET_HOURS_POLL_MS);
	});
	onUnmounted(() => {
		if (quietTimer !== null) clearInterval(quietTimer);
		quietTimer = null;
	});
}
