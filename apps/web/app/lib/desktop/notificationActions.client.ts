/**
 * Routing for desktop notification actions (D13). The Rust backend emits a
 * `notification-action` event ({ action: 'open' | 'archive', messageId,
 * folderRole }) when the user clicks a per-message notification or its Archive
 * button (macOS/Linux). The pure resolver maps that to an app effect; the
 * executor focuses the window and navigates / triages. No-op outside Tauri.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConvexClient } from 'convex/browser';

export interface NotificationActionPayload {
	action?: unknown;
	messageId?: unknown;
	folderRole?: unknown;
}

export type NotifEffect =
	| { type: 'open'; folderRole: string; messageId: string }
	| { type: 'archive'; messageId: string }
	| { type: 'read'; messageId: string }
	| null;

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Pure: map a notification-action payload to an app effect. */
export function resolveNotificationEffect(payload: NotificationActionPayload): NotifEffect {
	const messageId = str(payload?.messageId);
	if (!messageId) return null;
	if (payload.action === 'archive') return { type: 'archive', messageId };
	if (payload.action === 'read') return { type: 'read', messageId };
	return { type: 'open', folderRole: str(payload?.folderRole) ?? 'inbox', messageId };
}

async function focusMainWindow(): Promise<void> {
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const w = getCurrentWindow();
		await w.show();
		await w.setFocus();
	} catch {
		// Not running under Tauri.
	}
}

async function runEffect(effect: NonNullable<NotifEffect>, convex: ConvexClient): Promise<void> {
	// The Archive / Mark-read actions triage in place WITHOUT navigating away —
	// they should not steal the user's current view. Only an explicit open
	// (notification body / tray peek) focuses + deep-links.
	if (effect.type === 'archive') {
		await focusMainWindow();
		try {
			await convex.mutation(api.mail.messageActions.archive, {
				messageIds: [effect.messageId as Id<'mailMessages'>],
			});
		} catch (e) {
			console.warn('[desktop] archive from notification failed', e);
		}
		return;
	}
	if (effect.type === 'read') {
		try {
			await convex.mutation(api.mail.messageActions.markRead, {
				messageId: effect.messageId as Id<'mailMessages'>,
				seen: true,
			});
		} catch (e) {
			console.warn('[desktop] mark-read from notification failed', e);
		}
		return;
	}
	await focusMainWindow();
	window.location.assign(`/dashboard/postbox/${effect.folderRole}/${effect.messageId}`);
}

/** Subscribe to notification action events + route them. Call once (desktop). */
export async function setupNotificationActionRouting(convex: ConvexClient): Promise<void> {
	try {
		const { onNotificationAction } = await import('@owlat/desktop/src/notifications');
		await onNotificationAction((payload) => {
			const effect = resolveNotificationEffect(payload);
			if (effect) void runEffect(effect, convex);
		});
	} catch {
		// Not running under Tauri.
	}
}
