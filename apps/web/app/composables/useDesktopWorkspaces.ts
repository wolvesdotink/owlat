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
	snapshotKeychain,
} from '~/lib/desktop/keychainStorage';
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

// ---- module-level reactive state (shared across all callers) ----
const workspaces = ref<WorkspaceConfig[]>([]);
const activeId = ref<string | null>(null);
let loaded = false;

// Pending "add workspace" handshakes, keyed by CSRF state nonce. Populated when
// the system browser is opened; consumed when the owlat://auth deep link returns.
const pending = new Map<string, { id: string; info: InstanceInfo }>();

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
 */
export async function loadWorkspaces(options?: { seedLocalDev?: boolean }): Promise<void> {
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
 */
async function addWorkspace(siteUrlInput: string): Promise<void> {
	const siteUrl = normalizeSiteUrl(siteUrlInput);

	const res = await fetch(`${siteUrl}/api/instance-info`, { credentials: 'omit' });
	if (!res.ok) throw new Error(`Could not reach an owlat instance at ${siteUrl}`);
	const info = (await res.json()) as InstanceInfo;
	if (!info.convexUrl || !info.convexSiteUrl) {
		throw new Error('That instance did not return a usable configuration.');
	}

	const id = crypto.randomUUID();
	const state = crypto.randomUUID();
	pending.set(state, { id, info });

	const target = new URL('/desktop/connect', info.siteUrl || siteUrl);
	target.searchParams.set('state', state);
	target.searchParams.set('redirect', 'owlat://auth');

	const { openExternal } = await import('@owlat/desktop/src/shell');
	await openExternal(target.toString());
}

/**
 * Redeem the one-time token returned via the deep link, persist the session to
 * the new workspace's keychain entry, record the workspace, and reload into it.
 */
export async function completeConnection(params: { ott: string; state: string }): Promise<void> {
	const entry = pending.get(params.state);
	if (!entry) throw new Error('Unexpected sign-in response (state mismatch).');
	pending.delete(params.state);

	const { id, info } = entry;
	const tokenRef = workspaceTokenRef(id);

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

	await (
		tempClient as unknown as {
			$fetch: (path: string, opts: Record<string, unknown>) => Promise<unknown>;
		}
	).$fetch('/cross-domain/one-time-token/verify', {
		method: 'POST',
		body: { token: params.ott },
	});

	const session = (await tempClient.getSession()) as { data?: { user?: { id?: string } } };
	const userId = session?.data?.user?.id ?? '';

	// Force-persist the session blob before reload (beat the debounced flush).
	const { secretSet } = await keychain();
	await secretSet(tokenRef, snapshotKeychain());

	const now = Date.now();
	const ws: WorkspaceConfig = {
		id,
		label: info.name,
		siteUrl: info.siteUrl,
		convexUrl: info.convexUrl,
		convexSiteUrl: info.convexSiteUrl,
		userId,
		tokenRef,
		addedAt: now,
		lastActiveAt: now,
		// Preserve a user-chosen accent when re-authing an already-connected
		// workspace; only assign round-robin for a genuinely new one.
		accentColor:
			workspaces.value.find((w) => w.id === id)?.accentColor ??
			pickAccentColor(workspaces.value.filter((w) => w.id !== id).length),
	};
	workspaces.value = [...workspaces.value.filter((w) => w.id !== id), ws];
	activeId.value = id;
	await persistStore();

	window.location.assign('/dashboard');
}

async function switchTo(id: string): Promise<void> {
	if (id === activeId.value) return;
	const ws = workspaces.value.find((w) => w.id === id);
	if (!ws) return;
	ws.lastActiveAt = Date.now();
	activeId.value = id;
	await persistStore();

	// Perceived-instant switch (piece d4): before the (unavoidable) reload,
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
	window.location.assign('/dashboard');
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

	window.location.assign(workspaces.value.length ? '/dashboard' : '/desktop/welcome');
}

export function useDesktopWorkspaces() {
	const active = computed(() => workspaces.value.find((w) => w.id === activeId.value) ?? null);
	return {
		workspaces: readonly(workspaces),
		activeId: readonly(activeId),
		active,
		addWorkspace,
		completeConnection,
		switchTo,
		removeWorkspace,
		setWorkspaceAccent,
		signOutWorkspace: removeWorkspace,
	};
}
