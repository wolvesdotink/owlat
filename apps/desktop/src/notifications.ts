/**
 * Desktop notification bridge.
 *
 * Wraps @tauri-apps/plugin-notification and Tauri invoke commands
 * for sending native OS notifications and updating the tray badge.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
}

/**
 * Send a per-message notification with an Archive action. On macOS/Linux the
 * action button renders and clicking it (or the notification) emits the
 * `notification-action` event handled via {@link onNotificationAction}; on
 * other targets this degrades to a plain notification.
 */
export async function sendActionableNotification(
	title: string,
	body: string,
	messageId: string,
	folderRole: string,
): Promise<void> {
	try {
		await invoke('send_actionable_notification', { title, body, messageId, folderRole });
	} catch (e) {
		console.warn('[desktop] Failed to send actionable notification:', e);
	}
}

/** Subscribe to notification action events emitted by the Rust backend. */
export async function onNotificationAction(
	cb: (payload: NotificationActionPayload) => void,
): Promise<UnlistenFn | null> {
	try {
		return await listen<NotificationActionPayload>('notification-action', (e) => cb(e.payload));
	} catch (e) {
		console.warn('[desktop] Failed to subscribe to notification actions:', e);
		return null;
	}
}

/**
 * Update the system tray badge with the current unread count.
 */
export async function updateTrayBadge(count: number): Promise<void> {
	try {
		await invoke('update_tray_badge', { count: Math.max(0, Math.round(count)) });
	} catch (e) {
		console.warn('[desktop] Failed to update tray badge:', e);
	}
}
