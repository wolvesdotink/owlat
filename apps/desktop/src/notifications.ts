/**
 * Desktop notification bridge.
 *
 * Wraps @tauri-apps/plugin-notification and Tauri invoke commands
 * for sending native OS notifications and updating the app-icon unread badge.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';

/**
 * OS notification permission as the app reasons about it.
 *
 *   - `granted`   — toasts will be shown.
 *   - `prompt`    — never asked; the OS will ask on the next request.
 *   - `denied`    — the user said no. Nothing the app can do from code: the
 *                   only way back is the OS settings pane, which is why the
 *                   settings panel offers a link to it.
 *   - `unavailable` — no Tauri bridge (we are in the browser), or the plugin
 *                   call threw. Never treated as a hard block: the send path
 *                   still tries, exactly as it did before this check existed.
 */
export type DesktopNotificationPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

/**
 * Read the current permission WITHOUT prompting. `isPermissionGranted()`
 * returns a bare boolean, so a false is either "not asked yet" or "refused" —
 * indistinguishable here. We report `prompt`, the recoverable reading, and only
 * {@link requestNotificationPermission} can turn a false into a definite
 * `denied` (the OS answers the request itself).
 */
export async function checkNotificationPermission(): Promise<DesktopNotificationPermission> {
	try {
		return (await isPermissionGranted()) ? 'granted' : 'prompt';
	} catch {
		return 'unavailable';
	}
}

/**
 * Ask the OS for notification permission, prompting the user if it has not been
 * decided yet. Idempotent: an already-granted or already-refused permission
 * returns immediately without a second prompt.
 */
export async function requestNotificationPermission(): Promise<DesktopNotificationPermission> {
	try {
		if (await isPermissionGranted()) return 'granted';
		const result = await requestPermission();
		if (result === 'granted') return 'granted';
		return result === 'denied' ? 'denied' : 'prompt';
	} catch {
		return 'unavailable';
	}
}

/**
 * Send a native OS notification via the Tauri backend.
 */
export async function sendDesktopNotification(title: string, body: string): Promise<void> {
	try {
		await invoke('send_native_notification', { title, body });
	} catch (e) {
		console.warn('[desktop] Failed to send notification:', e);
	}
}

export interface NotificationActionPayload {
	action: string;
	messageId: string;
	folderRole: string;
	/** Text typed into the macOS inline reply field (absent for other actions). */
	reply?: string;
}

/**
 * Send a per-message notification with inline actions. On macOS it renders an
 * inline Reply field plus an Archive button; on Linux it renders Open / Archive
 * / Mark read. Interacting (or clicking the notification) emits the
 * `notification-action` event handled via {@link onNotificationAction}; on
 * other targets this degrades to a plain notification.
 */
export async function sendActionableNotification(
	title: string,
	body: string,
	messageId: string,
	folderRole: string
): Promise<void> {
	try {
		await invoke('send_actionable_notification', { title, body, messageId, folderRole });
	} catch (e) {
		console.warn('[desktop] Failed to send actionable notification:', e);
	}
}

/** Subscribe to notification action events emitted by the Rust backend. */
export async function onNotificationAction(
	cb: (payload: NotificationActionPayload) => void
): Promise<UnlistenFn | null> {
	try {
		return await listen<NotificationActionPayload>('notification-action', (e) => cb(e.payload));
	} catch (e) {
		console.warn('[desktop] Failed to subscribe to notification actions:', e);
		return null;
	}
}

/**
 * Update the app-icon unread badge (macOS dock, Windows taskbar, Linux Unity)
 * with the current unread count. A count of 0 clears the badge.
 */
export async function updateUnreadBadge(count: number): Promise<void> {
	try {
		await invoke('update_unread_badge', { count: Math.max(0, Math.round(count)) });
	} catch (e) {
		console.warn('[desktop] Failed to update unread badge:', e);
	}
}
