import { getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { emptyTrayContent, trayContent } from '~/lib/desktop/trayContent';
import type { UnreadPeekMessage } from '~/lib/desktop/notificationRules';
import type { UnreadBadge } from '~/composables/useUnreadBadge';

/**
 * Mounted owners. A layout switch (dashboard ↔ preferences) can mount the new
 * dashboard before it unmounts the old one, so only the last owner to leave
 * clears the tray.
 */
let owners = 0;

/**
 * Feeds the desktop tray icon (src-tauri tray.rs) from the shared unread peek:
 * the badge count, the newest unread messages and whether notifications are
 * paused, plus the device settings that show the icon and decide what closing
 * the window does. The dashboard layout owns it, next to the dock badge.
 *
 * Leaving the dashboard inside the SPA (signing out) clears what it reported;
 * a new document is cleared by the Rust side. No-op in the browser.
 */
export function useDesktopTray(unread: UnreadBadge) {
	const { isDesktop } = useDesktopContext();
	const { hidePreview } = usePostboxSettings();
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
			const { showTrayIcon, closeToTray } = settings.value.global;
			return { visible: showTrayIcon, closeToTray };
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

	watch(
		() => {
			if (!isDesktop.value) return null;
			return trayContent({
				count: unread.count.value,
				messages: (unread.data.value?.messages ?? []) as UnreadPeekMessage[],
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
