/**
 * Desktop notification bridge.
 *
 * Wraps @tauri-apps/plugin-notification and Tauri invoke commands
 * for sending native OS notifications and updating the app-icon unread badge.
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
