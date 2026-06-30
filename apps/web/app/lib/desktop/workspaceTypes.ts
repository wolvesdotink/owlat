/**
 * Desktop workspace model.
 *
 * A "workspace" is one connected owlat instance + the account signed into it.
 * The desktop app (Tauri) is multi-workspace (Slack-style), so it persists a
 * list of these plus which one is active. Non-secret metadata lives in
 * `tauri-plugin-store` (`workspaces.json`); the BetterAuth session blob lives in
 * the OS keychain, referenced here only by `tokenRef`.
 */
export interface WorkspaceConfig {
	/** Stable client-generated id (uuid). Namespaces store + keychain entries. */
	id: string;
	/** User-facing label shown in the switcher (defaults to instance name/host). */
	label: string;
	/** Instance web origin, e.g. https://acme.owlat.app — login page + deep-link return. */
	siteUrl: string;
	/** Convex client (WebSocket) URL — what `new ConvexClient(url)` receives. */
	convexUrl: string;
	/** Convex site URL — hosts /api/auth/* (BetterAuth + the convex token endpoint). */
	convexSiteUrl: string;
	/** BetterAuth user id for this connection (display/disambiguation only). */
	userId: string;
	/** OS-keychain account key holding the session blob (e.g. `owlat-ws:{id}`). */
	tokenRef: string;
	/** Epoch ms when the workspace was added. */
	addedAt: number;
	/** Epoch ms when the workspace was last made active. */
	lastActiveAt: number;
}

/** Shape persisted to `workspaces.json` via tauri-plugin-store. */
export interface WorkspaceStoreShape {
	workspaces: WorkspaceConfig[];
	activeWorkspaceId: string | null;
}

/** Public, credential-less instance metadata returned by GET /api/instance-info. */
export interface InstanceInfo {
	name: string;
	convexUrl: string;
	convexSiteUrl: string;
	siteUrl: string;
	deploymentMode: string;
}

export const WORKSPACE_STORE_FILE = 'workspaces.json';

/** Keychain account key for a workspace's session blob. */
export function workspaceTokenRef(id: string): string {
	return `owlat-ws:${id}`;
}
