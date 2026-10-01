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
 *
 * Two lifetime rules keep an action from running twice or in the wrong place:
 *
 *   - One subscription per main window. The dashboard layout owns the routing
 *     and disposes it on unmount (a registration still in flight is disposed
 *     the moment it lands); a newer owner replaces an older one. Every webview
 *     hears the event, so secondary windows (compose) never subscribe.
 *   - Actions run in the workspace that sent the notification. The payload
 *     carries its `workspaceId`; a notification from another workspace switches
 *     there first (the switch reloads the webview) and carries the action across
 *     the reload in sessionStorage. A workspace that is gone gets a notice, never
 *     a call to the workspace that happens to be active.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { optimisticArchive, optimisticMarkRead } from '~/lib/mailOptimistic/mailUpdaters';
import {
	PENDING_NOTIFICATION_ACTION_KEY,
	resolveNotificationWorkspace,
	takePendingAction,
	writePendingAction,
} from '~/lib/desktop/notificationWorkspace';

type NotifMessage = FunctionReturnType<typeof api.mail.mailbox.messages.getMessage>;

export interface NotificationActionPayload {
	action?: unknown;
	messageId?: unknown;
	folderRole?: unknown;
	reply?: unknown;
	/** The desktop workspace the notification was sent from. */
	workspaceId?: unknown;
	/** Process-unique id of the native notification (see notifications.rs). */
	notificationId?: unknown;
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
		// A blank or whitespace-only submission carries no words to preserve —
		// fall through to opening the thread rather than sending a blank message.
		if (text?.trim()) return { type: 'reply', messageId, text };
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

/** Pure: build the `/compose?to=…&subject=…&body=…` fallback path from an
 * already-loaded message (or null when it couldn't be read), always preserving
 * the user's typed text. No I/O — the single fetch lives in the caller. */
function composePathForReply(message: NotifMessage, text: string): string {
	const params = new URLSearchParams();
	if (message) {
		const to = message.replyToAddress ?? message.fromAddress;
		if (to) params.set('to', to);
		const subject = /^re\s*:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
		params.set('subject', subject);
	}
	if (text) params.set('body', text);
	const qs = params.toString();
	return qs ? `/compose?${qs}` : '/compose';
}

async function readOriginal(convex: ConvexClient, id: Id<'mailMessages'>): Promise<NotifMessage> {
	try {
		return await convex.query(api.mail.mailbox.messages.getMessage, { messageId: id });
	} catch (e) {
		console.warn('[desktop] notification reply: could not read original', e);
		return null;
	}
}

/**
 * Send an inline reply through the existing draft pipeline (create → set body →
 * send). On ANY failure, open the composer prefilled with the typed text so the
 * user's words survive. Exported for unit testing the fallback path.
 *
 * `send: false` skips straight to the prefilled composer: a reply carried
 * across a workspace switch that waited too long (a sign-in in between) is put
 * in front of the user rather than sent unattended.
 */
export async function replyFromNotification(
	convex: ConvexClient,
	messageId: string,
	text: string,
	deps: ReplyDeps,
	options: { send?: boolean } = {}
): Promise<void> {
	const id = messageId as Id<'mailMessages'>;
	// One fetch of the original — reused for both the send and the fallback path
	// so an unreadable original never triggers a second doomed round trip.
	const message = await readOriginal(convex, id);
	if (message && options.send !== false) {
		try {
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
			return;
		} catch (e) {
			console.warn('[desktop] notification reply failed; opening composer', e);
		}
	}
	await deps.openComposer(composePathForReply(message, text));
}

/**
 * Route a thread open through the SPA router (Nuxt `navigateTo`) rather than a
 * full document load. Injected so the `open` path is unit-testable without a
 * live Nuxt/router context — mirrors the {@link ReplyDeps.openComposer}
 * injection the reply path already uses.
 */
export type NavigateFn = (path: string) => void;

async function openDesktopComposer(path: string): Promise<void> {
	const { openCompose } = await import('@owlat/desktop/src/compose');
	await openCompose(path);
}

function threadPath(effect: { folderRole: string; messageId: string }): string {
	return `/dashboard/postbox/${effect.folderRole}/${effect.messageId}`;
}

export async function runEffect(
	effect: NonNullable<NotifEffect>,
	convex: ConvexClient,
	navigate: NavigateFn,
	openComposer: ReplyDeps['openComposer'] = openDesktopComposer
): Promise<void> {
	// The Archive / Mark-read actions triage in place WITHOUT navigating away —
	// they should not steal the user's current view. Only an explicit open
	// (clicking the notification body) focuses + deep-links.
	if (effect.type === 'archive') {
		await focusMainWindow();
		try {
			// The open window's lists and badges move at once (plan 2.2).
			await convex.mutation(
				api.mail.messageActions.archive,
				{ messageIds: [effect.messageId as Id<'mailMessages'>] },
				{ optimisticUpdate: optimisticArchive }
			);
		} catch (e) {
			console.warn('[desktop] archive from notification failed', e);
		}
		return;
	}
	if (effect.type === 'read') {
		try {
			await convex.mutation(
				api.mail.messageActions.markRead,
				{ messageId: effect.messageId as Id<'mailMessages'>, seen: true },
				{ optimisticUpdate: optimisticMarkRead }
			);
		} catch (e) {
			console.warn('[desktop] mark-read from notification failed', e);
		}
		return;
	}
	if (effect.type === 'reply') {
		// Reply-and-send stays in the background (no focus steal); only the
		// fallback opens a window, which focuses itself.
		await replyFromNotification(convex, effect.messageId, effect.text, { openComposer });
		return;
	}
	// Clicking the notification body focuses the window and deep-links to the
	// thread through the SPA router (no full document reload).
	await focusMainWindow();
	navigate(threadPath(effect));
}

// ── Workspace provenance ────────────────────────────────────────────────────

/** The desktop workspace list, as the routing needs it. Injected for tests. */
export interface NotificationWorkspaces {
	/** The workspace this page load (and its Convex client) is bound to. */
	activeId: () => string | null;
	exists: (id: string) => boolean;
	/** Make `id` active; reloads the webview and lands on `destination`. */
	switchTo: (id: string, destination: string) => Promise<void>;
	/**
	 * The notification's workspace was removed. Tell the user; a reply's text
	 * must stay recoverable.
	 */
	onUnavailable: (effect: NonNullable<NotifEffect>) => void;
	/**
	 * A reply from another workspace could not be stored for the switch. The
	 * switch reloads the webview and would drop it, so nothing switches and the
	 * user gets the text back, with the workspace it belongs to.
	 */
	onReplyNotCarried: (effect: Extract<NotifEffect, { type: 'reply' }>, workspaceId: string) => void;
}

export interface NotificationRoutingContext {
	/** The Convex client of {@link NotificationWorkspaces.activeId}. */
	convex: ConvexClient;
	navigate: NavigateFn;
	workspaces: NotificationWorkspaces;
	/** Carries an action across the switch reload (sessionStorage). */
	storage: Storage | null;
	/** Resolves true once the client's auth is confirmed (see convexAuthReady). */
	authReady: () => Promise<boolean>;
	openComposer?: ReplyDeps['openComposer'];
	now?: () => number;
}

/**
 * Route one notification action. Runs it here when the notification came from
 * the active workspace; otherwise switches to its workspace (carrying the action
 * across the reload), or reports a workspace that no longer exists. Never
 * calls the active workspace's backend for another workspace's message.
 */
export async function handleNotificationAction(
	payload: NotificationActionPayload,
	ctx: NotificationRoutingContext
): Promise<void> {
	const effect = resolveNotificationEffect(payload);
	if (!effect) return;
	const { workspaces } = ctx;
	const route = resolveNotificationWorkspace(
		payload.workspaceId,
		workspaces.activeId(),
		workspaces.exists
	);
	if (route.kind === 'here') {
		await runEffect(effect, ctx.convex, ctx.navigate, ctx.openComposer);
		return;
	}
	await focusMainWindow();
	if (route.kind === 'gone') {
		workspaces.onUnavailable(effect);
		return;
	}
	// An open needs nothing but the destination. Anything else rides the reload
	// in sessionStorage. If that cannot be written, a triage action lands on the
	// thread so the user can act there; a reply stays here, because its words
	// exist only in this page and the reload would lose them.
	const carried =
		effect.type !== 'open' &&
		!!ctx.storage &&
		writePendingAction(
			ctx.storage,
			route.workspaceId,
			{
				action: effect.type,
				messageId: effect.messageId,
				...(effect.type === 'reply' ? { reply: effect.text } : {}),
			},
			(ctx.now ?? Date.now)()
		);
	if (effect.type === 'reply' && !carried) {
		workspaces.onReplyNotCarried(effect, route.workspaceId);
		return;
	}
	const destination =
		effect.type === 'open'
			? threadPath(effect)
			: carried
				? '/dashboard'
				: threadPath({ folderRole: 'inbox', messageId: effect.messageId });
	await workspaces.switchTo(route.workspaceId, destination);
}

/**
 * Run the action a workspace switch carried here, once this workspace's auth is
 * confirmed. Without auth (an expired session) it stays stored for after the
 * sign-in; by then it is stale, so a reply opens prefilled instead of sending.
 */
export async function runPendingAction(ctx: NotificationRoutingContext): Promise<void> {
	if (!ctx.storage) return;
	const activeId = ctx.workspaces.activeId();
	if (!activeId || !ctx.storage.getItem(PENDING_NOTIFICATION_ACTION_KEY)) return;
	if (!(await ctx.authReady())) return;
	const pending = takePendingAction(ctx.storage, activeId, (ctx.now ?? Date.now)());
	// Re-derived through the same resolver as a live event, so a corrupted entry
	// resolves to nothing rather than to a malformed mutation.
	const effect = pending && resolveNotificationEffect(pending.payload);
	if (!pending || !effect) return;
	const { fresh } = pending;
	const openComposer = ctx.openComposer ?? openDesktopComposer;
	if (fresh) {
		await runEffect(effect, ctx.convex, ctx.navigate, openComposer);
	} else if (effect.type === 'reply') {
		await replyFromNotification(
			ctx.convex,
			effect.messageId,
			effect.text,
			{ openComposer },
			{ send: false }
		);
	}
}

// ── Subscription lifetime ───────────────────────────────────────────────────

/**
 * Notification ids already routed in this document. Each native notification
 * emits at most one action, so a repeat is a duplicate delivery. Bounded.
 */
const routedNotificationIds = new Set<number>();

function firstDelivery(payload: NotificationActionPayload): boolean {
	const id = payload.notificationId;
	if (typeof id !== 'number') return true;
	if (routedNotificationIds.has(id)) return false;
	if (routedNotificationIds.size >= 200) routedNotificationIds.clear();
	routedNotificationIds.add(id);
	return true;
}

/** Whether this webview is the main window (no window API: the only window). */
async function isMainWindow(): Promise<boolean> {
	try {
		const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
		return getCurrentWebviewWindow().label === 'main';
	} catch {
		return true;
	}
}

/** Disposer of the registration currently owning the subscription. */
let activeRouting: (() => void) | null = null;

export interface NotificationRouting {
	/** Unsubscribe. Safe to call while registration is still in flight. */
	dispose: () => void;
	/** Settles once registration (and any carried action) has finished. */
	ready: Promise<void>;
}

/**
 * Subscribe to notification action events and route them (desktop main window
 * only). The caller owns the result and must dispose it; a newer registration
 * disposes the previous one, so at most one subscription is ever live.
 */
export function setupNotificationActionRouting(
	ctx: NotificationRoutingContext
): NotificationRouting {
	activeRouting?.();
	let disposed = false;
	let unlisten: (() => void) | null = null;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		unlisten?.();
		unlisten = null;
		if (activeRouting === dispose) activeRouting = null;
	};
	activeRouting = dispose;

	const ready = (async () => {
		try {
			if (!(await isMainWindow()) || disposed) return;
			const { onNotificationAction } = await import('@owlat/desktop/src/notifications');
			const off = await onNotificationAction((payload) => {
				if (!disposed && firstDelivery(payload)) void handleNotificationAction(payload, ctx);
			});
			// The owner went away while we were registering: drop the late listener.
			if (disposed) {
				off?.();
				return;
			}
			unlisten = off;
			await runPendingAction(ctx);
		} catch {
			// Not running under Tauri.
		}
	})();
	return { dispose, ready };
}
