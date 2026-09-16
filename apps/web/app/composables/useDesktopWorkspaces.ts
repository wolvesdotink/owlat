/**
 * Multi-workspace manager for the desktop app (Slack-style).
 *
 * Owns the reactive list of connected owlat instances + which is active, and the
 * actions to add / switch / remove / sign out. Adding or switching a workspace
 * reloads the webview so the auth + Convex singletons (built at module load from
 * the active workspace) are cleanly re-seeded — see auth-client.ts / convex.client.ts.
 *
 * No-op outside the Tauri runtime.
 */
import { createAuthClient } from 'better-auth/vue';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient } from 'better-auth/client/plugins';
import { isDesktopRuntime, setActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import {
	keychainStorage,
	configureKeychainStorage,
	clearKeychainStorage,
	currentKeychainAccount,
	resetKeychainStorage,
	snapshotKeychain,
} from '~/lib/desktop/keychainStorage';
import {
	clearPendingConnections,
	takePendingConnection,
	writePendingConnection,
	type PendingStorage,
} from '~/lib/desktop/pendingConnections';
import {
	type InstanceInfo,
	type WorkspaceAccent,
	type WorkspaceConfig,
	type WorkspaceStoreShape,
	pickAccentColor,
	workspaceTokenRef,
} from '~/lib/desktop/workspaceTypes';
import { applyWorkspaceAccent } from '~/lib/desktop/workspaceAccent';
import {
	hideSwitchSkeleton,
	showSwitchSkeleton,
	SWITCH_FLAG_TTL_MS,
	writeSwitchFlag,
} from '~/lib/desktop/workspaceSwitch';

/**
 * A failure the connect UI shows the user. The functions that throw it run at
 * module scope (deep links, boot), where `useI18n` does not exist — so they
 * carry a message KEY plus its values, and `useDesktopWorkspaces()` translates
 * on the way out (see `localizeErrors`).
 */
class WorkspaceConnectionError extends Error {
	constructor(
		readonly messageKey: string,
		readonly params: Record<string, unknown> = {}
	) {
		super(messageKey);
		this.name = 'WorkspaceConnectionError';
	}
}

// ---- module-level reactive state (shared across all callers) ----
const workspaces = ref<WorkspaceConfig[]>([]);
const activeId = ref<string | null>(null);
let loaded = false;

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
const connectError = ref<{ messageKey: string; params: Record<string, unknown> } | null>(null);

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

type KeychainBridge = typeof import('@owlat/desktop/src/keychain');
type WorkspaceBridge = typeof import('@owlat/desktop/src/workspace');

async function keychain(): Promise<KeychainBridge> {
	return import('@owlat/desktop/src/keychain');
}
async function store(): Promise<WorkspaceBridge> {
	return import('@owlat/desktop/src/workspace');
}

function makePersister() {
	return (account: string, blob: string) => {
		void keychain().then((k) => k.secretSet(account, blob));
	};
}

async function persistStore(): Promise<void> {
	const { saveWorkspaceStore } = await store();
	await saveWorkspaceStore({
		workspaces: workspaces.value,
		activeWorkspaceId: activeId.value,
	} satisfies WorkspaceStoreShape);
}

/** Stable id for the dev-only auto-seeded localhost workspace. Deterministic so
 * its keychain entry (`owlat-ws:local-dev`) survives a workspaces.json wipe and
 * a previously stored dev session signs back in without any reconnect. */
export const LOCAL_DEV_WORKSPACE_ID = 'local-dev';

const LOCAL_DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Dev-only auto-connect. Under `tauri dev` the webview loads the local Nuxt dev
 * server directly (tauri.conf.json `devUrl`), so the instance the developer
 * wants is always the page's own origin — discover its Convex URLs via the
 * same-origin /api/instance-info probe and upsert a workspace for it, instead
 * of routing through the manual connect flow (system browser + `owlat://` deep
 * link, which doesn't even fire in dev builds). Fail-soft: any probe error
 * leaves the store untouched and the normal welcome flow takes over.
 */
async function seedLocalDevWorkspace(): Promise<void> {
	const origin = window.location.origin;
	if (!LOCAL_DEV_ORIGIN_RE.test(origin)) return;

	let info: InstanceInfo;
	try {
		const res = await fetch(`${origin}/api/instance-info`, { credentials: 'omit' });
		if (!res.ok) return;
		info = (await res.json()) as InstanceInfo;
	} catch {
		return;
	}
	if (!info.convexUrl || !info.convexSiteUrl) return;

	const sameOrigin = (url: string) => {
		try {
			return new URL(url).origin === origin;
		} catch {
			return false;
		}
	};
	// A workspace already pointing at this dev instance (seeded earlier, or
	// added manually via the connect flow) is reused — never duplicated. Its
	// endpoints are refreshed since local Convex ports can change between runs.
	let local = workspaces.value.find(
		(w) => w.id === LOCAL_DEV_WORKSPACE_ID || sameOrigin(w.siteUrl)
	);
	if (local) {
		local.siteUrl = info.siteUrl || origin;
		local.convexUrl = info.convexUrl;
		local.convexSiteUrl = info.convexSiteUrl;
	} else {
		const now = Date.now();
		local = {
			id: LOCAL_DEV_WORKSPACE_ID,
			label: info.name || 'Local dev',
			siteUrl: info.siteUrl || origin,
			convexUrl: info.convexUrl,
			convexSiteUrl: info.convexSiteUrl,
			userId: '',
			tokenRef: workspaceTokenRef(LOCAL_DEV_WORKSPACE_ID),
			addedAt: now,
			lastActiveAt: now,
			accentColor: pickAccentColor(workspaces.value.length),
		};
		workspaces.value = [...workspaces.value, local];
	}

	// Activate it only when nothing (valid) is active — a developer who switched
	// to some other connected workspace keeps their choice.
	if (!activeId.value || !workspaces.value.some((w) => w.id === activeId.value)) {
		activeId.value = local.id;
	}
	await persistStore();
}

/**
 * Read the persisted workspaces, seed the active-workspace singleton, and
 * hydrate the keychain cache for the active workspace. Awaited by the boot
 * plugin BEFORE the Convex/auth singletons are first imported.
 *
 * `seedLocalDev` (passed by the boot plugin only in dev) auto-connects the
 * page's own origin as a workspace — see `seedLocalDevWorkspace`.
 *
 * `preferredActiveId` (the user's "Open at startup" pin, passed by the boot
 * plugin only on a cold launch of the main window — never on the webview
 * reloads a workspace switch performs) overrides the persisted last-active
 * workspace when it still exists. Persisted when applied, so secondary windows
 * (compose) reading the store agree on the active workspace.
 */
export async function loadWorkspaces(options?: {
	seedLocalDev?: boolean;
	preferredActiveId?: string | null;
}): Promise<void> {
	if (!isDesktopRuntime() || loaded) return;
	loaded = true;

	const { loadWorkspaceStore } = await store();
	const state = (await loadWorkspaceStore()) as unknown as WorkspaceStoreShape;
	workspaces.value = Array.isArray(state.workspaces) ? state.workspaces : [];
	activeId.value = state.activeWorkspaceId ?? workspaces.value[0]?.id ?? null;

	// Backfill identity accents for workspaces persisted before this field
	// existed, round-robin by position so each still gets a distinct color.
	let backfilled = false;
	workspaces.value.forEach((w, i) => {
		if (!w.accentColor) {
			w.accentColor = pickAccentColor(i);
			backfilled = true;
		}
	});
	if (backfilled) await persistStore();

	if (options?.seedLocalDev) await seedLocalDevWorkspace();

	if (
		options?.preferredActiveId &&
		options.preferredActiveId !== activeId.value &&
		workspaces.value.some((w) => w.id === options.preferredActiveId)
	) {
		activeId.value = options.preferredActiveId;
		await persistStore();
	}

	const active = workspaces.value.find((w) => w.id === activeId.value) ?? null;
	setActiveWorkspace(active);

	if (active) {
		const { secretGet } = await keychain();
		const blob = await secretGet(active.tokenRef);
		configureKeychainStorage(active.tokenRef, blob, makePersister());
	}
}

/** Normalize a user-typed instance URL into an origin (https unless localhost). */
export function normalizeSiteUrl(input: string): string {
	let raw = input.trim();
	const hasScheme = /^https?:\/\//i.test(raw);
	if (!hasScheme) raw = `https://${raw}`;
	const url = new URL(raw);
	const isLocal = /^(localhost|127\.0\.0\.1)/.test(url.hostname);
	if (!isLocal) {
		url.protocol = 'https:';
	} else if (!hasScheme) {
		// Schemeless localhost input ("localhost:3000") means a plain-http dev
		// server — defaulting it to https would TLS-fail with an opaque
		// "Load failed". An explicit https://localhost is left untouched.
		url.protocol = 'http:';
	}
	return url.origin;
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
async function addWorkspace(siteUrlInput: string): Promise<void> {
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
 * Redeem the one-time token returned via the deep link, persist the session to
 * the new workspace's keychain entry, record the workspace, and reload into it.
 *
 * Throws — and leaves NOTHING behind — unless a real session came back. A
 * half-finished handshake used to be persisted as a fully connected workspace
 * (with an empty `userId`), which the router then bounced straight back to
 * /desktop/welcome: the server looked "added" while being unusable.
 */
export async function completeConnection(params: { ott: string; state: string }): Promise<void> {
	const entry = takePendingConnection(pendingStorage(), params.state, Date.now());
	if (!entry)
		throw new WorkspaceConnectionError('shared.useDesktopWorkspaces.errors.stateMismatch');

	const { id, info } = entry;
	const tokenRef = workspaceTokenRef(id);

	// Re-pointing the (single, global) keychain cache at the new workspace's
	// entry is destructive: remember where it pointed so a failed handshake can
	// put it back, instead of leaving the ACTIVE workspace writing its session
	// into the abandoned workspace's keychain entry.
	const previousAccount = currentKeychainAccount();
	const previousBlob = snapshotKeychain();

	// Point the (single, global) keychain cache at the new workspace's entry so
	// the cross-domain client persists the redeemed session there.
	configureKeychainStorage(tokenRef, null, makePersister());

	// A throwaway client for the new instance: redeeming through it lets the
	// cross-domain client capture the Set-Better-Auth-Cookie into keychainStorage.
	const tempClient = createAuthClient({
		baseURL: info.convexSiteUrl,
		plugins: [
			convexClient(),
			organizationClient(),
			crossDomainClient({ storage: keychainStorage }),
		],
	});

	try {
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

		// Force-persist the session blob before reload (beat the debounced flush).
		const { secretSet } = await keychain();
		await secretSet(tokenRef, snapshotKeychain());

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
		// Undo every side effect. The cross-domain client writes through a
		// DEBOUNCED flush, and a handshake takes far longer than the debounce, so
		// by now it has very likely persisted something under the abandoned
		// workspace — or, when the cache was re-pointed at an account that was
		// already in use, over the previously-active workspace's own entry.
		const { secretSet, secretDelete } = await keychain();
		if (previousAccount) {
			configureKeychainStorage(previousAccount, previousBlob, makePersister());
			// Put the previously-active workspace's blob back on disk, not just in
			// the cache: a failed attempt to connect a SECOND server must not sign
			// the user out of the one they are already using.
			await secretSet(previousAccount, previousBlob);
		} else {
			resetKeychainStorage();
		}
		// Drop the entry minted for the workspace we are abandoning. Skipped when
		// it belongs to a workspace that is still in the list (a re-auth of an
		// already-connected server): that entry is the workspace's own, and the
		// failed re-auth leaves it as it was — stale, which is what the user is
		// retrying to fix.
		if (tokenRef !== previousAccount && !workspaces.value.some((w) => w.id === id)) {
			await secretDelete(tokenRef);
		}
		throw e;
	}

	// A successful connect retires every other in-flight handshake too: retries
	// leave abandoned nonces behind, and a later deep link for one of them would
	// otherwise re-run the flow against a workspace the user has already got.
	clearPendingConnections(pendingStorage());
	connectError.value = null;
	window.location.assign('/dashboard');
}

async function switchTo(id: string, opts?: { destination?: string }): Promise<void> {
	if (id === activeId.value) return;
	const ws = workspaces.value.find((w) => w.id === id);
	if (!ws) return;
	ws.lastActiveAt = Date.now();
	activeId.value = id;
	await persistStore();

	// Perceived-instant switch: before the (unavoidable) reload,
	// repaint the destination accent and drop a skeleton washed in it so the eye
	// sees the target workspace's colour immediately. A sessionStorage flag hands
	// the same skeleton to the fresh document (consumed by the boot plugin), which
	// crossfades it out on first paint. Purely paint-order choreography — the
	// reload below still does all the real re-seeding.
	if (typeof document !== 'undefined') {
		applyWorkspaceAccent(document.documentElement, ws.accentColor);
		writeSwitchFlag(sessionStorage, {
			accent: ws.accentColor,
			label: ws.label,
			at: Date.now(),
		});
		const skeleton = showSwitchSkeleton(ws.accentColor, ws.label);
		// Stale-skeleton guard on the INITIATING document (mirrors the fresh
		// document's boot-plugin TTL). The skeleton is a full-window,
		// pointer-events-blocking overlay; if location.assign below stalls or the
		// webview navigation fails, this document keeps it forever and the app is
		// stuck behind an opaque sheet. After the same TTL, drop the skeleton and
		// fall back to a plain reload — which still re-seeds into the (already
		// persisted) new active workspace. A successful navigation unloads this
		// document first, so the timer never fires on the happy path.
		window.setTimeout(() => {
			hideSwitchSkeleton(skeleton);
			window.location.reload();
		}, SWITCH_FLAG_TTL_MS);
	}
	// `destination` lets callers land somewhere specific after the re-seeding
	// reload (e.g. /desktop/settings → "Workspace settings" → /dashboard/admin).
	window.location.assign(opts?.destination ?? '/dashboard');
}

/**
 * Recolor a workspace's identity accent. Repaints the live chrome immediately
 * when the recolored workspace is the active one (no reload needed) and
 * persists the choice so it survives restart.
 */
async function setWorkspaceAccent(id: string, color: WorkspaceAccent): Promise<void> {
	const ws = workspaces.value.find((w) => w.id === id);
	if (!ws || ws.accentColor === color) return;
	ws.accentColor = color;
	if (id === activeId.value && typeof document !== 'undefined') {
		applyWorkspaceAccent(document.documentElement, color);
	}
	await persistStore();
}

async function removeWorkspace(id: string): Promise<void> {
	const wasActive = id === activeId.value;
	if (wasActive) {
		try {
			// Lazy import so merely loading this module (at boot, for loadWorkspaces)
			// does not construct the auth-client singleton before the active
			// workspace has been seeded.
			const { authClient } = await import('~/lib/auth-client');
			await authClient.signOut();
		} catch {
			// best-effort; we're discarding the session anyway
		}
		clearKeychainStorage();
	}
	const { secretDelete } = await keychain();
	await secretDelete(workspaceTokenRef(id));

	workspaces.value = workspaces.value.filter((w) => w.id !== id);
	if (wasActive) activeId.value = workspaces.value[0]?.id ?? null;
	await persistStore();

	// Drop the workspace's device-local settings (mute, startup pin) so
	// settings.json doesn't accumulate orphaned entries. Before the reload
	// below — pruneWorkspaceSettings persists synchronously-awaited.
	try {
		const { pruneWorkspaceSettings } = await import('~/composables/useDesktopAppSettings');
		await pruneWorkspaceSettings(id);
	} catch {
		// Best-effort cleanup; an orphaned entry is harmless.
	}

	window.location.assign(workspaces.value.length ? '/dashboard' : '/desktop/welcome');
}

/**
 * The message catalog, resolved where one exists.
 *
 * `useDesktopWorkspaces()` is reached from the `desktop-workspace.global` route
 * guard — outside any component `setup()`, where `useI18n()` THROWS and would
 * take down every desktop navigation. The guard only reads `active`; it never
 * runs a connect flow, so outside a component the copy degrades to its key.
 * Mirrors `useAuth.ts` and `useOrganization.ts`.
 */
function workspaceTranslator(): (key: string, params?: Record<string, unknown>) => string {
	if (!getCurrentInstance()) return (key: string) => key;
	const { t } = useI18n();
	return (key: string, params?: Record<string, unknown>) => t(key, params ?? {});
}

export function useDesktopWorkspaces() {
	const t = workspaceTranslator();
	const active = computed(() => workspaces.value.find((w) => w.id === activeId.value) ?? null);

	/**
	 * The connect flow renders `error.message` straight into the form, so the
	 * key-carrying failures from the module-scope functions are translated here —
	 * the one place in this module with a locale.
	 */
	async function localizeErrors<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (e) {
			if (e instanceof WorkspaceConnectionError) throw new Error(t(e.messageKey, e.params));
			throw e;
		}
	}

	return {
		workspaces: readonly(workspaces),
		activeId: readonly(activeId),
		active,
		/**
		 * The last handshake failure, translated — `null` when the last attempt
		 * succeeded or none has run. Lets the connect UI explain a deep-link
		 * return that failed after the user had already left for the browser.
		 */
		connectError: computed(() =>
			connectError.value ? t(connectError.value.messageKey, connectError.value.params) : null
		),
		clearConnectFailure,
		addWorkspace: (siteUrlInput: string) => localizeErrors(() => addWorkspace(siteUrlInput)),
		completeConnection: (params: { ott: string; state: string }) =>
			localizeErrors(() => completeConnection(params)),
		switchTo,
		removeWorkspace,
		setWorkspaceAccent,
		signOutWorkspace: removeWorkspace,
	};
}
