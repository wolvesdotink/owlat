/**
 * Multi-workspace manager for the desktop app (Slack-style).
 *
 * Owns the reactive list of connected owlat instances + which is active, and the
 * actions to add / switch / remove / sign out. Adding or switching a workspace
 * reloads the webview so the auth + Convex singletons (built at module load from
 * the active workspace) are cleanly re-seeded — see auth-client.ts / convex.client.ts.
 *
 * No-op outside the Tauri runtime.
 *
 * The shared workspace list + persistence bridges live in
 * lib/desktop/workspaceState.ts, and the browser sign-in handshake in
 * lib/desktop/workspaceConnect.ts; this file owns boot, switching, removal and
 * the public composable.
 */
import { isDesktopRuntime, setActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { configureKeychainStorage, clearKeychainStorage } from '~/lib/desktop/keychainStorage';
import {
	type WorkspaceAccent,
	type WorkspaceStoreShape,
	type InstanceInfo,
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
import {
	activeId,
	keychain,
	makePersister,
	persistStore,
	store,
	workspaces,
	WorkspaceConnectionError,
} from '~/lib/desktop/workspaceState';
import {
	addWorkspace,
	clearConnectFailure,
	completeConnection,
	connectError,
} from '~/lib/desktop/workspaceConnect';

// Re-exported because the URL normalizer is part of this composable's public
// contract (the connect form calls it through `addWorkspace`) even though it now
// lives with the state it validates against.
export { normalizeSiteUrl } from '~/lib/desktop/workspaceState';

let loaded = false;

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
