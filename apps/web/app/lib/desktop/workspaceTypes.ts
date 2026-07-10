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
	/**
	 * Curated identity accent (hex) that paints this workspace's desktop frame,
	 * titlebar wash, sidebar tint and active-nav highlight. Assigned round-robin
	 * from {@link WORKSPACE_ACCENTS} when the workspace is added; user-editable
	 * from the workspace switcher's accent picker.
	 */
	accentColor: WorkspaceAccent;
}

/**
 * Curated workspace identity accents — value + human label colocated so a
 * palette change can never desync the swatch labels from the hexes. Assigned
 * round-robin as workspaces are added so each connected instance gets a
 * distinct, on-brand frame color.
 */
export const WORKSPACE_ACCENT_OPTIONS = [
	{ value: '#7a8c5a', label: 'Moss' },
	{ value: '#c4785a', label: 'Terracotta' }, // matches the FF brand hue
	{ value: '#5a7a9b', label: 'Slate' },
	{ value: '#8c5a7a', label: 'Plum' },
	{ value: '#b8935a', label: 'Gold' },
	{ value: '#3d3d3d', label: 'Graphite' },
] as const;

/** One of the curated workspace accent hexes — derived from the options so a
 * new option can never desync the union from the runtime palette. */
export type WorkspaceAccent = (typeof WORKSPACE_ACCENT_OPTIONS)[number]['value'];

/**
 * Curated workspace identity accents (hex), derived from
 * {@link WORKSPACE_ACCENT_OPTIONS}. Order: moss, terracotta, slate, plum, gold,
 * graphite.
 */
export const WORKSPACE_ACCENTS: readonly WorkspaceAccent[] = WORKSPACE_ACCENT_OPTIONS.map(
	(o) => o.value
);

/** Human label for a curated accent hex, or a generic fallback. */
export function accentLabel(color: string): string {
	return WORKSPACE_ACCENT_OPTIONS.find((o) => o.value === color)?.label ?? 'Accent';
}

/**
 * Up-to-two-letter avatar initials for a workspace label. Strips a leading
 * protocol so a raw instance URL still yields sane letters. Used by the
 * Slack-style workspace rail (WorkspaceSwitcher) to paint each tile's swatch.
 */
export function initials(label: string): string {
	return label
		.replace(/^https?:\/\//, '')
		.split(/[\s.]+/)
		.map((p) => p[0])
		.filter(Boolean)
		.join('')
		.toUpperCase()
		.slice(0, 2);
}

/** Clamp an unread badge count to the two-plus-glyph "99+" convention. */
export function formatBadgeCount(count: number): string {
	return count > 99 ? '99+' : String(count);
}

/** Fallback accent when none has been assigned yet (the terracotta brand hue). */
export const DEFAULT_WORKSPACE_ACCENT: WorkspaceAccent = WORKSPACE_ACCENT_OPTIONS[1].value;

/**
 * Round-robin pick from the curated accents for the Nth added workspace.
 * Handles negative and out-of-range indices defensively.
 */
export function pickAccentColor(index: number): WorkspaceAccent {
	const len = WORKSPACE_ACCENTS.length;
	const i = ((Math.trunc(index) % len) + len) % len;
	return WORKSPACE_ACCENTS[i] ?? DEFAULT_WORKSPACE_ACCENT;
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
