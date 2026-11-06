/**
 * Tray icon bridge.
 *
 * The Rust shell (src-tauri tray.rs) owns the icon; the main window's SPA
 * tells it what to show (`updateTray`) and whether to show it at all
 * (`setTrayPreferences`). The icon's "Pause Notifications" item asks the SPA
 * to flip its notification switch through `onTrayToggleNotifications`, and
 * "Check for Mail" asks it to request a sync through `onTrayCheckMail`; its
 * message rows reuse the `notification-action` event (notifications.ts). No-op
 * outside Tauri.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** One unread message as the tray menu lists it. */
export interface TrayMessage {
	messageId: string;
	sender: string;
	subject: string;
}

export interface TrayContent {
	/** `null` when this page has no count to show. */
	unread: number | null;
	/** Newest first; the menu lists at most five. */
	messages: TrayMessage[];
	/** The workspace the messages belong to; a click opens them there. */
	workspaceId: string | null;
	notificationsPaused: boolean;
}

export interface TrayPreferences {
	visible: boolean;
	/** Windows and Linux: closing the main window hides it to the tray. */
	closeToTray: boolean;
	/** macOS: no Dock icon while the menu bar icon is shown. */
	hideDockIcon: boolean;
}

export async function updateTray(content: TrayContent): Promise<void> {
	try {
		await invoke('update_tray', {
			unread: content.unread === null ? null : Math.max(0, Math.round(content.unread)),
			messages: content.messages,
			workspaceId: content.workspaceId,
			notificationsPaused: content.notificationsPaused,
		});
	} catch (e) {
		console.warn('[desktop] Failed to update the tray icon:', e);
	}
}

export async function setTrayPreferences(preferences: TrayPreferences): Promise<void> {
	try {
		await invoke('set_tray_preferences', {
			visible: preferences.visible,
			closeToTray: preferences.closeToTray,
			hideDockIcon: preferences.hideDockIcon,
		});
	} catch (e) {
		console.warn('[desktop] Failed to apply the tray settings:', e);
	}
}

/** The tray's "Pause Notifications" item was clicked. */
export async function onTrayToggleNotifications(cb: () => void): Promise<UnlistenFn> {
	return listen('tray://toggle-notifications', () => cb());
}

/** The tray's "Check for Mail" item was clicked. */
export async function onTrayCheckMail(cb: () => void): Promise<UnlistenFn> {
	return listen('tray://check-mail', () => cb());
}
