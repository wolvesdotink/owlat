import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { emptyTrayContent, trayContent } from '~/lib/desktop/trayContent';
import { badgeCount, type UnreadPeekMessage } from '~/lib/desktop/notificationRules';
import type { UnreadBadge } from '~/composables/useUnreadBadge';

/** The menu lists five rows; the badge's peek carries the same window. */
const TRAY_PEEK_LIMIT = 5;

/**
 * Mounted owners. A layout switch (dashboard ↔ preferences) can mount the new
 * dashboard before it unmounts the old one, so only the last owner to leave
 * clears the tray.
 */
let owners = 0;

/**
 * Feeds the desktop tray icon (src-tauri tray.rs) from the shared unread peek:
 * the badge count, the newest unread messages and whether notifications are
 * paused, plus the device settings that show the icon, decide what closing
 * the window does and hide the Dock icon. The dashboard layout owns it, next
 * to the dock badge.
 *
 * When the workspace's device settings name one mailbox for the tray, the tray
 * reads that mailbox through a subscription of its own, and the dock badge
 * keeps counting every inbox. A mailbox that can no longer be read (removed,
 * or access withdrawn) sends the tray back to all inboxes.
 *
 * Leaving the dashboard inside the SPA (signing out) clears what it reported;
 * a new document is cleared by the Rust side. No-op in the browser.
 */
export function useDesktopTray(unread: UnreadBadge) {
	const { isDesktop } = useDesktopContext();
	const { hidePreview, badgeNonPeople } = usePostboxSettings();
	const { settings, isReady } = useDesktopAppSettings();

	// One pending import shared by both watchers: a settings change wakes them
	// in the same tick. A failed load is forgotten so the next call can retry.
	function importTray() {
		return import('@owlat/desktop/src/tray');
	}
	let pending: ReturnType<typeof importTray> | null = null;
	function bridge(): ReturnType<typeof importTray> {
		pending ??= importTray().catch((error: unknown) => {
			pending = null;
			throw error;
		});
		return pending;
	}

	// The settings file is read by the Rust side at launch; until this page has
	// read it too, the defaults here would overwrite the stored choice.
	watch(
		() => {
			if (!isDesktop.value || !isReady.value) return null;
			const { showTrayIcon, closeToTray, hideDockIcon } = settings.value.global;
			return { visible: showTrayIcon, closeToTray, hideDockIcon };
		},
		async (preferences) => {
			if (!preferences) return;
			try {
				await (await bridge()).setTrayPreferences(preferences);
			} catch {
				// Tauri modules unavailable.
			}
		},
		{ immediate: true }
	);

	const trayMailboxId = computed(() => {
		if (!isDesktop.value) return null;
		const workspaceId = getActiveWorkspace()?.id;
		return workspaceId ? (settings.value.workspaces[workspaceId]?.trayMailboxId ?? null) : null;
	});
	const { data: mailboxPeek } = useConvexQuery(api.mail.mailbox.queries.newestUnreadInbox, () =>
		trayMailboxId.value
			? { limit: TRAY_PEEK_LIMIT, mailboxId: trayMailboxId.value as Id<'mailboxes'> }
			: 'skip'
	);

	/** The count and rows the tray shows: the chosen mailbox's, or the badge's. */
	const source = computed<{ count: number | null; messages: UnreadPeekMessage[] }>(() => {
		const badge = {
			count: unread.count.value,
			messages: (unread.data.value?.messages ?? []) as UnreadPeekMessage[],
		};
		if (!trayMailboxId.value) return badge;
		const peek = mailboxPeek.value;
		if (!peek) return { count: null, messages: [] };
		if (peek.unavailable) return badge;
		const messages = peek.messages as UnreadPeekMessage[];
		return { count: badgeCount(peek.total, messages, badgeNonPeople.value), messages };
	});

	watch(
		() => {
			if (!isDesktop.value) return null;
			return trayContent({
				count: source.value.count,
				messages: source.value.messages,
				badgeNonPeople: badgeNonPeople.value,
				hidePreview: hidePreview.value,
				notificationsEnabled: settings.value.global.notificationsEnabled,
				workspaceId: getActiveWorkspace()?.id ?? null,
			});
		},
		async (content) => {
			if (!content) return;
			try {
				await (await bridge()).updateTray(content);
			} catch {
				// Tauri modules unavailable.
			}
		},
		{ immediate: true }
	);

	onMounted(() => {
		owners += 1;
	});
	onUnmounted(() => {
		owners = Math.max(0, owners - 1);
		if (owners > 0 || !isDesktop.value) return;
		const content = emptyTrayContent(settings.value.global.notificationsEnabled);
		void bridge()
			.then(({ updateTray }) => updateTray(content))
			.catch(() => {});
	});
}
