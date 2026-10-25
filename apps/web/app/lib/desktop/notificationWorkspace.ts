/**
 * Workspace provenance for desktop notification actions.
 *
 * A native notification outlives a workspace switch, and message ids only mean
 * something on the instance that issued them. So every actionable notification
 * carries the id of the workspace that sent it, and its action runs there:
 *
 *   - from the active workspace → run it here;
 *   - from another connected workspace → switch to it (the switch reloads the
 *     webview) and carry the action across the reload in sessionStorage;
 *   - from a workspace that has since been removed → tell the user, run nothing.
 *
 * Pure: storage is injected, nothing here talks to Convex or Tauri. The routing
 * itself lives in `notificationActions.client.ts`.
 */

import { decodeJsonText, guardDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared/utils/guards';

/** Where an action has to run, given the workspace its notification came from. */
export type NotificationWorkspaceRoute =
	| { kind: 'here' }
	| { kind: 'switch'; workspaceId: string }
	| { kind: 'gone'; workspaceId: string };

/**
 * Route an action by the workspace that sent its notification. A payload
 * without a workspace (the browser, or a notification sent while none was
 * active) can only mean the current one.
 */
export function resolveNotificationWorkspace(
	origin: unknown,
	activeId: string | null,
	exists: (id: string) => boolean
): NotificationWorkspaceRoute {
	if (typeof origin !== 'string' || origin.length === 0 || origin === activeId) {
		return { kind: 'here' };
	}
	return exists(origin)
		? { kind: 'switch', workspaceId: origin }
		: { kind: 'gone', workspaceId: origin };
}

/** sessionStorage key carrying an action across the workspace-switch reload. */
export const PENDING_NOTIFICATION_ACTION_KEY = 'owlat:notification-action';

/**
 * How long a carried action may wait for its workspace and still run
 * unattended. A switch reloads in seconds; anything older waited on a sign-in,
 * so a reply then opens prefilled instead of sending and a triage action is
 * dropped.
 */
export const PENDING_ACTION_FRESH_MS = 2 * 60_000;

/** The parts of a `notification-action` payload worth carrying. */
export interface CarriedNotificationAction {
	action: string;
	messageId: string;
	reply?: string;
}

interface PendingNotificationAction {
	workspaceId: string;
	at: number;
	payload: CarriedNotificationAction;
}

/**
 * A stored entry, as an object; its fields are checked where they are used,
 * because one for another workspace must stay put whatever else it holds.
 */
const pendingDecoder = guardDecoder(isRecord, '$: expected an object');

/** Persist an action for the workspace it belongs to. False when storage failed. */
export function writePendingAction(
	storage: Storage,
	workspaceId: string,
	payload: CarriedNotificationAction,
	now: number
): boolean {
	const pending: PendingNotificationAction = { workspaceId, at: now, payload };
	try {
		storage.setItem(PENDING_NOTIFICATION_ACTION_KEY, JSON.stringify(pending));
		return true;
	} catch {
		return false;
	}
}

/**
 * Take the carried action if it belongs to the active workspace. One that
 * belongs to another workspace stays put: it must never run here. Only the
 * payload's object shape is checked; the caller resolves its fields like a
 * live event's.
 */
export function takePendingAction(
	storage: Storage,
	activeId: string | null,
	now: number
): { payload: Record<string, unknown>; fresh: boolean } | null {
	let pending: Record<string, unknown> | null;
	try {
		const raw = storage.getItem(PENDING_NOTIFICATION_ACTION_KEY);
		const decoded = raw ? decodeJsonText(raw, pendingDecoder) : null;
		pending = decoded?.ok ? decoded.value : null;
	} catch {
		pending = null;
	}
	if (!pending) return null;
	if (!activeId || pending['workspaceId'] !== activeId) return null;
	try {
		storage.removeItem(PENDING_NOTIFICATION_ACTION_KEY);
	} catch {
		// A failed remove would replay the action on every mount; drop it instead.
		return null;
	}
	const { at, payload } = pending;
	if (typeof at !== 'number' || !isRecord(payload)) return null;
	return {
		payload,
		fresh: at <= now && now - at <= PENDING_ACTION_FRESH_MS,
	};
}
