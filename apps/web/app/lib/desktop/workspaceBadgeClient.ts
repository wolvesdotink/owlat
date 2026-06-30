/**
 * Lightweight background Convex client for an INACTIVE desktop workspace.
 *
 * The active workspace's badge is fed by the single global ConvexClient (built
 * from `getActiveWorkspace()`). Inactive workspaces have no client, so their
 * rail badge would be stuck at 0. This factory spins up a minimal, read-only
 * ConvexClient per inactive workspace — authed against THAT instance using the
 * session blob persisted in its own keychain entry — and subscribes to the same
 * two unread queries the active path uses, reporting a combined count.
 *
 * Desktop-only: it reads the OS keychain (Tauri) and talks cross-origin to each
 * instance's Convex site, carrying the session in the `Better-Auth-Cookie`
 * header (cookies don't survive the `tauri://localhost` hop — same mechanism as
 * `convex-auth.ts` for the active workspace).
 */
import { ConvexClient } from 'convex/browser';
import { api } from '@owlat/api';
import type { WorkspaceConfig } from './workspaceTypes';

/** Storage key the cross-domain BetterAuth client writes its cookie jar under. */
const COOKIE_STORAGE_KEY = 'better-auth_cookie';

/**
 * Turn a persisted keychain blob into a `key=value; …` Cookie header string.
 *
 * The blob is the serialized cross-domain storage cache: a `Record<string,
 * string>` whose `better-auth_cookie` entry is itself JSON of
 * `{ [name]: { value, expires } }`. Mirrors the cross-domain plugin's own
 * `getCookie`, dropping expired entries.
 */
export function cookieStringFromBlob(blob: string | null): string {
	if (!blob) return '';
	let jar: unknown;
	try {
		const cache = JSON.parse(blob) as Record<string, unknown>;
		jar = JSON.parse((cache[COOKIE_STORAGE_KEY] as string) || '{}');
	} catch {
		return '';
	}
	if (!jar || typeof jar !== 'object') return '';
	const now = Date.now();
	return Object.entries(jar as Record<string, { value?: string; expires?: string | null }>)
		.filter(([, v]) => !v?.expires || new Date(v.expires).getTime() >= now)
		.map(([name, v]) => `${name}=${v?.value ?? ''}`)
		.join('; ');
}

/** Read a workspace's session blob from the OS keychain (no-op in the browser). */
async function readWorkspaceCookie(ws: WorkspaceConfig): Promise<string> {
	try {
		const { secretGet } = await import('@owlat/desktop/src/keychain');
		const blob = await secretGet(ws.tokenRef);
		return cookieStringFromBlob(blob);
	} catch {
		return '';
	}
}

/**
 * Fetch a fresh Convex JWT for an inactive workspace using its stored cookie.
 * Returns null when the workspace has no usable session (signed out / expired).
 */
async function fetchWorkspaceToken(ws: WorkspaceConfig): Promise<string | null> {
	const cookie = await readWorkspaceCookie(ws);
	if (!cookie) return null;
	try {
		const base = ws.convexSiteUrl.replace(/\/+$/, '');
		const res = await fetch(`${base}/api/auth/convex/token`, {
			method: 'GET',
			credentials: 'omit',
			headers: { 'Better-Auth-Cookie': cookie },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { token?: string | null };
		return data.token ?? null;
	} catch {
		return null;
	}
}

/** A live background badge subscription; call `close()` to tear it down. */
export interface WorkspaceBadgeClient {
	close: () => void;
}

/**
 * Subscribe to one inactive workspace's unread counts and report the combined
 * total (inbox drafts-ready + unread chat mentions) via `onCount`. Mirrors the
 * active-workspace math in `useWorkspaceBadges`. The two queries are admin/auth
 * gated server-side and simply error for non-admins — those errors are swallowed
 * and the badge stays at its last value (0), so this never throws into the rail.
 */
export function createWorkspaceBadgeClient(
	ws: WorkspaceConfig,
	onCount: (count: number) => void,
): WorkspaceBadgeClient {
	const client = new ConvexClient(ws.convexUrl);
	client.setAuth(() => fetchWorkspaceToken(ws));

	let drafts = 0;
	let mentions = 0;
	const emit = () => onCount(drafts + mentions);

	const unsubInbox = client.onUpdate(
		api.inbox.queries.getInboundStats,
		{},
		(stats) => {
			drafts = (stats as { draftReady?: number } | null)?.draftReady ?? 0;
			emit();
		},
		() => {
			drafts = 0;
			emit();
		},
	);

	const unsubMentions = client.onUpdate(
		api.chat.mentions.countMyUnreadMentions,
		{},
		(count) => {
			mentions = typeof count === 'number' ? count : 0;
			emit();
		},
		() => {
			mentions = 0;
			emit();
		},
	);

	return {
		close: () => {
			unsubInbox();
			unsubMentions();
			void client.close();
		},
	};
}
