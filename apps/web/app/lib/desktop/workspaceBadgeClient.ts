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
import { decodeJsonText, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared/utils/guards';
import { api } from '@owlat/api';
import { readAuthTokenAnswer } from '~/lib/authTokenResponse';
import { parseKeychainBlob } from './keychainStorage';
import type { WorkspaceConfig } from './workspaceTypes';

/** Storage key the cross-domain BetterAuth client writes its cookie jar under. */
const COOKIE_STORAGE_KEY = 'better-auth_cookie';

/** One cookie of the jar: `{ value, expires }`, `expires` an ISO date or null. */
interface StoredCookie {
	name: string;
	value: string;
	expires: string | null;
}

/** The jar's cookies; an entry of any other shape is skipped, never coerced into the header. */
const cookieJarDecoder = parserDecoder((value): StoredCookie[] | null => {
	if (!isRecord(value)) return null;
	const cookies: StoredCookie[] = [];
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry) || typeof entry['value'] !== 'string') continue;
		const expires = entry['expires'] ?? null;
		if (expires !== null && typeof expires !== 'string') continue;
		cookies.push({ name, value: entry['value'], expires });
	}
	return cookies;
}, '$: expected a cookie jar object');

/**
 * Turn a persisted keychain blob into a `key=value; …` Cookie header string.
 *
 * The blob is the serialized cross-domain storage cache: a `Record<string,
 * string>` whose `better-auth_cookie` entry is itself JSON of
 * `{ [name]: { value, expires } }`. Mirrors the cross-domain plugin's own
 * `getCookie`, dropping expired entries.
 */
export function cookieStringFromBlob(blob: string | null): string {
	const jar = parseKeychainBlob(blob)[COOKIE_STORAGE_KEY];
	if (!jar) return '';
	const decoded = decodeJsonText(jar, cookieJarDecoder);
	if (!decoded.ok) return '';
	const now = Date.now();
	return decoded.value
		.filter(({ expires }) => !expires || new Date(expires).getTime() >= now)
		.map(({ name, value }) => `${name}=${value}`)
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
		const answer = readAuthTokenAnswer(await res.json().catch(() => undefined));
		return answer.kind === 'token' ? answer.token : null;
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
	onCount: (count: number) => void
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
		}
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
		}
	);

	return {
		close: () => {
			unsubInbox();
			unsubMentions();
			void client.close();
		},
	};
}
