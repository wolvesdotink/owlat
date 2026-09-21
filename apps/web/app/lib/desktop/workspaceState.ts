/**
 * Shared state for the desktop workspace manager.
 *
 * The connected-instance list and which one is active are module-level and
 * deliberately singleton: the composable (useDesktopWorkspaces.ts) and the
 * connect handshake (workspaceConnect.ts) act on the SAME list, and a per-caller
 * copy would let a completed handshake update a list nobody is rendering.
 *
 * Kept out of `composables/` on purpose — Nuxt auto-imports every export from
 * there, and these internals are not a public surface.
 */
import { ref } from 'vue';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';

/**
 * A failure the connect UI shows the user. The functions that throw it run at
 * module scope (deep links, boot), where `useI18n` does not exist — so they
 * carry a message KEY plus its values, and `useDesktopWorkspaces()` translates
 * on the way out (see `localizeErrors`).
 */
export class WorkspaceConnectionError extends Error {
	constructor(
		readonly messageKey: string,
		readonly params: Record<string, unknown> = {}
	) {
		super(messageKey);
		this.name = 'WorkspaceConnectionError';
	}
}

// ---- module-level reactive state (shared across all callers) ----
export const workspaces = ref<WorkspaceConfig[]>([]);
export const activeId = ref<string | null>(null);

type KeychainBridge = typeof import('@owlat/desktop/src/keychain');
type WorkspaceBridge = typeof import('@owlat/desktop/src/workspace');

export async function keychain(): Promise<KeychainBridge> {
	return import('@owlat/desktop/src/keychain');
}
export async function store(): Promise<WorkspaceBridge> {
	return import('@owlat/desktop/src/workspace');
}

export function makePersister() {
	return (account: string, blob: string) => {
		void keychain().then((k) => k.secretSet(account, blob));
	};
}

export async function persistStore(): Promise<void> {
	const { saveWorkspaceStore } = await store();
	await saveWorkspaceStore({
		workspaces: workspaces.value,
		activeWorkspaceId: activeId.value,
	} satisfies WorkspaceStoreShape);
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
