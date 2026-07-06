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
	type WorkspaceConfig,
	type WorkspaceStoreShape,
	workspaceTokenRef,
} from '~/lib/desktop/workspaceTypes';

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

/**
 * Read the persisted workspaces, seed the active-workspace singleton, and
 * hydrate the keychain cache for the active workspace. Awaited by the boot
 * plugin BEFORE the Convex/auth singletons are first imported.
 */
export async function loadWorkspaces(): Promise<void> {
	if (!isDesktopRuntime() || loaded) return;
	loaded = true;

	const { loadWorkspaceStore } = await store();
	const state = (await loadWorkspaceStore()) as unknown as WorkspaceStoreShape;
	workspaces.value = Array.isArray(state.workspaces) ? state.workspaces : [];
	activeId.value = state.activeWorkspaceId ?? workspaces.value[0]?.id ?? null;

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
	};
	workspaces.value = [...workspaces.value.filter((w) => w.id !== id), ws];
	activeId.value = id;
	await persistStore();

	window.location.assign('/dashboard');
}

async function switchTo(id: string): Promise<void> {
	if (id === activeId.value) return;
	const ws = workspaces.value.find((w) => w.id === id);
	if (ws) ws.lastActiveAt = Date.now();
	activeId.value = id;
	await persistStore();
	window.location.assign('/dashboard');
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
		signOutWorkspace: removeWorkspace,
	};
}
