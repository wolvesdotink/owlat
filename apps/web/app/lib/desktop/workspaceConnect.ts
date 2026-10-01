/**
 * The desktop sign-in handshake.
 *
 * Adding a workspace cannot be done in-app: the packaged desktop has no login
 * form. `addWorkspace` opens the instance's /desktop/connect page in the SYSTEM
 * browser with a CSRF `state` nonce; the browser signs in there, mints a
 * one-time token, and hands it back via the `owlat://auth` deep link, which
 * `completeConnection` redeems into a cross-domain session.
 *
 * Split out of useDesktopWorkspaces.ts: the handshake is the one part with its
 * own failure surface (a redeem that fails, a nonce that expired, a session that
 * never materialized) and it is what the deep-link handler calls directly.
 */
import { ref } from 'vue';
import { createDesktopAuthClient } from '~/lib/auth-client';
import { createKeychainStorage, getActiveKeychainStorage } from '~/lib/desktop/keychainStorage';
import {
	clearPendingConnections,
	takePendingConnection,
	writePendingConnection,
	type PendingStorage,
} from '~/lib/desktop/pendingConnections';
import {
	type InstanceInfo,
	type WorkspaceConfig,
	pickAccentColor,
	workspaceTokenRef,
} from '~/lib/desktop/workspaceTypes';
import {
	WorkspaceConnectionError,
	activeId,
	keychain,
	normalizeSiteUrl,
	persistStore,
	workspaces,
} from '~/lib/desktop/workspaceState';

/**
 * The last connect failure, for the UI to show. The deep-link return runs at
 * module scope with no component to throw into (see deepLink.client.ts), so a
 * failed handshake would otherwise only reach the console — which is exactly
 * how a broken connect became "I clicked sign in and nothing happened".
 *
 * Held as a message KEY (not a rendered string) for the same reason the errors
 * themselves are: there is no locale at module scope. `useDesktopWorkspaces()`
 * translates it on the way out.
 */
export const connectError = ref<{ messageKey: string; params: Record<string, unknown> } | null>(
	null
);

/**
 * Record a handshake failure for the connect UI. Called from the deep-link
 * handler, which has no component to surface a rejection through.
 */
export function recordConnectFailure(e: unknown): void {
	connectError.value =
		e instanceof WorkspaceConnectionError
			? { messageKey: e.messageKey, params: e.params }
			: { messageKey: 'shared.useDesktopWorkspaces.errors.generic', params: {} };
}

/** Forget the last handshake failure (a new attempt, or a successful one). */
export function clearConnectFailure(): void {
	connectError.value = null;
}

/**
 * Durable storage for in-flight handshakes. `localStorage` survives the app
 * relaunch macOS performs to deliver a cold-start `owlat://auth` deep link; the
 * in-memory fallback keeps this working in tests and any non-browser context.
 */
const memoryPendingStore = new Map<string, string>();
const fallbackPendingStorage: PendingStorage = {
	getItem: (k) => memoryPendingStore.get(k) ?? null,
	setItem: (k, v) => void memoryPendingStore.set(k, v),
	removeItem: (k) => void memoryPendingStore.delete(k),
};

function pendingStorage(): PendingStorage {
	try {
		if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
	} catch {
		// Storage blocked (private mode / sandbox) — fall through.
	}
	return fallbackPendingStorage;
}

/**
 * Begin adding a workspace: discover the instance, then open the system browser
 * to its /desktop/connect page. Completion happens in `completeConnection` when
 * the `owlat://auth` deep link returns.
 *
 * Connecting an instance that is ALREADY in the list re-authenticates it in
 * place: it keeps the existing workspace id, so the completed handshake
 * overwrites that workspace (and its keychain entry) instead of adding a second
 * entry for the same server. That is the only way back from a workspace whose
 * session died — the alternative was a duplicate row per retry.
 */
export async function addWorkspace(siteUrlInput: string): Promise<void> {
	connectError.value = null;
	const siteUrl = normalizeSiteUrl(siteUrlInput);

	const res = await fetch(`${siteUrl}/api/instance-info`, { credentials: 'omit' });
	if (!res.ok) {
		throw new WorkspaceConnectionError('shared.useDesktopWorkspaces.errors.unreachable', {
			siteUrl,
		});
	}
	const info = (await res.json()) as InstanceInfo;
	if (!info.convexUrl || !info.convexSiteUrl) {
		throw new WorkspaceConnectionError('shared.useDesktopWorkspaces.errors.unusableConfig');
	}

	const id = findWorkspaceBySiteUrl(info.siteUrl || siteUrl)?.id ?? crypto.randomUUID();
	const state = crypto.randomUUID();
	writePendingConnection(pendingStorage(), state, { id, info, at: Date.now() });

	const target = new URL('/desktop/connect', info.siteUrl || siteUrl);
	target.searchParams.set('state', state);
	target.searchParams.set('redirect', 'owlat://auth');

	const { openExternal } = await import('@owlat/desktop/src/shell');
	await openExternal(target.toString());
}

/** The connected workspace for an instance origin, if any (origin-compared so
 * a trailing slash or a typed-in scheme can't mint a duplicate). */
function findWorkspaceBySiteUrl(siteUrl: string): WorkspaceConfig | undefined {
	let origin: string;
	try {
		origin = new URL(siteUrl).origin;
	} catch {
		return undefined;
	}
	return workspaces.value.find((w) => {
		try {
			return new URL(w.siteUrl).origin === origin;
		} catch {
			return false;
		}
	});
}

/** The `{ data, error }` envelope BetterAuth's `$fetch` resolves with. It does
 * NOT reject on a non-2xx response unless asked to, so the error arm is the
 * only place a failed redeem shows up. */
interface FetchEnvelope {
	error?: { status?: number; message?: string; statusText?: string } | null;
}

/**
 * Connection completions run one at a time. Two deep links can arrive together
 * (a retried handshake, a cold start delivering a queued link); run side by
 * side they would both write the workspace list and the keychain.
 */
let completionQueue: Promise<void> = Promise.resolve();

/**
 * Set once a completion has committed and started the reload into the new
 * workspace. A completion queued behind it has nothing left to do: the
 * committed one retired every other handshake.
 */
let committed = false;

/**
 * Redeem the one-time token returned via the deep link, persist the session to
 * the new workspace's keychain entry, record the workspace, and reload into it.
 *
 * Throws — and leaves NOTHING behind — unless a real session came back. A
 * half-finished handshake used to be persisted as a fully connected workspace
 * (with an empty `userId`), which the router then bounced straight back to
 * /desktop/welcome: the server looked "added" while being unusable.
 */
export function completeConnection(params: { ott: string; state: string }): Promise<void> {
	const run = completionQueue.then(() => (committed ? undefined : connect(params)));
	completionQueue = run.catch(() => {});
	return run;
}

async function connect(params: { ott: string; state: string }): Promise<void> {
	const entry = takePendingConnection(pendingStorage(), params.state, Date.now());
	if (!entry)
		throw new WorkspaceConnectionError('shared.useDesktopWorkspaces.errors.stateMismatch');

	const { id, info } = entry;
	const tokenRef = workspaceTokenRef(id);

	// The new session gets its own storage and its own client, and stays in
	// memory until it is confirmed. The workspace this window is signed in to
	// keeps its storage and client untouched while the handshake runs, so a
	// failed handshake has nothing to undo.
	const pending = createKeychainStorage(tokenRef, null, null);
	const tempClient = createDesktopAuthClient(info.convexSiteUrl, pending);

	const redeemed = (await (
		tempClient as unknown as {
			$fetch: (path: string, opts: Record<string, unknown>) => Promise<unknown>;
		}
	).$fetch('/cross-domain/one-time-token/verify', {
		method: 'POST',
		body: { token: params.ott },
	})) as FetchEnvelope | null;

	if (redeemed?.error) {
		// A 404 here is not a bad token: it means the instance does not serve
		// /cross-domain/one-time-token/verify at all, which is what an Owlat
		// server older than v0.4.14 looks like (its `oneTimeToken` plugin
		// shadowed the cross-domain route). Say so, because "sign-in failed"
		// sends the user hunting for the wrong problem.
		throw new WorkspaceConnectionError(
			redeemed.error.status === 404
				? 'shared.useDesktopWorkspaces.errors.verifyRouteMissing'
				: 'shared.useDesktopWorkspaces.errors.verifyFailed',
			{ siteUrl: info.siteUrl, status: redeemed.error.status ?? 0 }
		);
	}

	const session = (await tempClient.getSession()) as { data?: { user?: { id?: string } } };
	const userId = session?.data?.user?.id ?? '';
	if (!userId) {
		throw new WorkspaceConnectionError('shared.useDesktopWorkspaces.errors.noSession');
	}

	// Hand the keychain over. Re-authenticating the workspace this window is
	// signed in to means two writers for one entry: stop the current one (and
	// wait for its writes) before the new session is written. Any other
	// workspace's storage keeps its own entry, and is flushed so the reload
	// does not drop a change it still holds. Other windows signed in to this
	// workspace (an open compose window) are fenced by the replace itself: it
	// moves the entry's session revision on, so their writes of the older
	// session are refused and they read the new one.
	const current = getActiveKeychainStorage();
	const resumeCurrent = current?.accountKey === tokenRef ? await current.suspend() : null;
	const previousList = workspaces.value;
	const previousActiveId = activeId.value;
	const isNewWorkspace = !previousList.some((w) => w.id === id);
	let written = false;
	try {
		await current?.flush();
		const { sessionReplace } = await keychain();
		await sessionReplace(tokenRef, pending.snapshot());
		written = true;

		const now = Date.now();
		const existing = workspaces.value.find((w) => w.id === id);
		const ws: WorkspaceConfig = {
			id,
			label: info.name,
			siteUrl: info.siteUrl,
			convexUrl: info.convexUrl,
			convexSiteUrl: info.convexSiteUrl,
			userId,
			tokenRef,
			addedAt: existing?.addedAt ?? now,
			lastActiveAt: now,
			// Preserve a user-chosen accent when re-authing an already-connected
			// workspace; only assign round-robin for a genuinely new one.
			accentColor:
				existing?.accentColor ??
				pickAccentColor(workspaces.value.filter((w) => w.id !== id).length),
		};
		workspaces.value = [...workspaces.value.filter((w) => w.id !== id), ws];
		activeId.value = id;
		await persistStore();
	} catch (e) {
		// The workspace list did not get saved: put it back as it is on disk, and
		// drop the entry written for a workspace that is not in it. A re-auth
		// keeps its entry, which now holds the newer session; the current writer
		// goes back to it only when the new session never got there.
		workspaces.value = previousList;
		activeId.value = previousActiveId;
		if (written && isNewWorkspace) {
			const { sessionReplace } = await keychain();
			await sessionReplace(tokenRef, null).catch(() => {});
		}
		if (!written) resumeCurrent?.();
		throw e;
	}

	// A successful connect retires every other in-flight handshake too: retries
	// leave abandoned nonces behind, and a later deep link for one of them would
	// otherwise re-run the flow against a workspace the user has already got.
	committed = true;
	clearPendingConnections(pendingStorage());
	connectError.value = null;
	window.location.assign('/dashboard');
}
