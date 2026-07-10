/**
 * Routing for desktop notification actions (D13 + D5). The Rust backend emits a
 * `notification-action` event ({ action: 'open' | 'archive' | 'read' | 'reply',
 * messageId, folderRole, reply? }) when the user interacts with a per-message
 * notification (macOS/Linux). The pure resolver maps that to an app effect; the
 * executor focuses the window and navigates / triages / sends the reply. No-op
 * outside Tauri.
 *
 * The `reply` effect (macOS inline reply field) builds a reply spec through the
 * EXISTING draft pipeline — create → set body → send — with NO new send path.
 * If any step fails, the composer opens prefilled with the typed text so the
 * user's words are never lost.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import type { ConvexClient } from 'convex/browser';

export interface NotificationActionPayload {
	action?: unknown;
	messageId?: unknown;
	folderRole?: unknown;
	reply?: unknown;
}

export type NotifEffect =
	| { type: 'open'; folderRole: string; messageId: string }
	| { type: 'archive'; messageId: string }
	| { type: 'read'; messageId: string }
	| { type: 'reply'; messageId: string; text: string }
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
	if (payload.action === 'reply') {
		const text = str(payload?.reply);
		// An empty reply submission carries no words to preserve — fall through
		// to opening the thread rather than sending a blank message.
		if (text) return { type: 'reply', messageId, text };
	}
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

/** Injected side-effect so the reply flow is unit-testable without Tauri. */
export interface ReplyDeps {
	/** Open the desktop composer window at the given app-relative path. */
	openComposer: (path: string) => Promise<void>;
}

/** Build the `/compose?to=…&subject=…&body=…` fallback path, preserving the
 * user's typed text even when the original message can't be re-read. */
async function composePathForReply(
	convex: ConvexClient,
	messageId: Id<'mailMessages'>,
	text: string
): Promise<string> {
	const params = new URLSearchParams();
	try {
		const message = await convex.query(api.mail.mailbox.getMessage, { messageId });
		if (message) {
			const to = message.replyToAddress ?? message.fromAddress;
			if (to) params.set('to', to);
			const subject = /^re\s*:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
			params.set('subject', subject);
		}
	} catch {
		// Best-effort — the body below is the part we must never lose.
	}
	if (text) params.set('body', text);
	const qs = params.toString();
	return qs ? `/compose?${qs}` : '/compose';
}

/**
 * Send an inline reply through the existing draft pipeline (create → set body →
 * send). On ANY failure, open the composer prefilled with the typed text so the
 * user's words survive. Exported for unit testing the fallback path.
 */
export async function replyFromNotification(
	convex: ConvexClient,
	messageId: string,
	text: string,
	deps: ReplyDeps
): Promise<void> {
	const id = messageId as Id<'mailMessages'>;
	try {
		const message = await convex.query(api.mail.mailbox.getMessage, { messageId: id });
		if (!message) throw new Error('message unavailable');
		const { draftId } = await convex.mutation(api.mail.drafts.create, {
			mailboxId: message.mailboxId,
			inReplyToMessageId: id,
		});
		await convex.mutation(api.mail.drafts.update, {
			draftId,
			bodyHtml: escapeHtmlWithBreaks(text),
			bodyText: text,
		});
		await convex.mutation(api.mail.drafts.send, { draftId });
	} catch (e) {
		console.warn('[desktop] notification reply failed; opening composer', e);
		await deps.openComposer(await composePathForReply(convex, id, text));
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
	if (effect.type === 'reply') {
		// Reply-and-send stays in the background (no focus steal); only the
		// fallback opens a window, which focuses itself.
		await replyFromNotification(convex, effect.messageId, effect.text, {
			openComposer: async (path) => {
				const { openCompose } = await import('@owlat/desktop/src/compose');
				await openCompose(path);
			},
		});
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
