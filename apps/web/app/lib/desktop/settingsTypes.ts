/**
 * Desktop app-settings model (device-scoped — spans all workspaces).
 *
 * Persisted to `settings.json` via tauri-plugin-store (see apps/desktop
 * src/settings.ts, the pass-through JSON bridge) and surfaced on
 * /desktop/settings. Two scopes live here:
 *
 *   - `global`: one value for the whole install (update checks, notification
 *     toggles, startup workspace);
 *   - `workspaces`: device-local per-workspace preferences keyed by workspace
 *     id (currently notification mute). Server-side workspace settings stay in
 *     Convex and are NOT mirrored here.
 *
 * The store is read with `normalizeDesktopSettings`, which merges any raw
 * value over the defaults — a missing, corrupt, or older-versioned file can
 * never throw or surface partial state.
 */

export const SETTINGS_STORE_FILE = 'settings.json';

export const SETTINGS_VERSION = 1;

export interface GlobalDesktopSettings {
	/** Run the non-blocking update check on app boot. Manual checks always work. */
	autoCheckUpdates: boolean;
	/** Master switch for native notification toasts (badge is separate). */
	notificationsEnabled: boolean;
	/** Show the unread-count badge on the dock/taskbar icon. */
	showUnreadBadge: boolean;
	/** Workspace to activate on a cold app launch; null = last active. */
	startupWorkspaceId: string | null;
}

/** Device-local per-workspace preferences (keyed by workspace id). */
export interface WorkspaceLocalSettings {
	/** Suppress notification toasts while this workspace is active. */
	muteNotifications: boolean;
}

/** Shape persisted to `settings.json` (key `state`). */
export interface DesktopSettings {
	version: number;
	global: GlobalDesktopSettings;
	workspaces: Record<string, WorkspaceLocalSettings>;
}

export function defaultDesktopSettings(): DesktopSettings {
	return {
		version: SETTINGS_VERSION,
		global: {
			autoCheckUpdates: true,
			notificationsEnabled: true,
			showUnreadBadge: true,
			startupWorkspaceId: null,
		},
		workspaces: {},
	};
}

export function defaultWorkspaceLocalSettings(): WorkspaceLocalSettings {
	return { muteNotifications: false };
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/**
 * Merge a raw store value over the defaults. Tolerates null (missing file),
 * junk, and unknown versions — every field falls back independently so one
 * corrupted key can never take the rest of the settings down with it.
 */
export function normalizeDesktopSettings(raw: unknown): DesktopSettings {
	const base = defaultDesktopSettings();
	if (typeof raw !== 'object' || raw === null) return base;
	const r = raw as Record<string, unknown>;

	const g = (typeof r['global'] === 'object' && r['global'] !== null ? r['global'] : {}) as Record<
		string,
		unknown
	>;
	base.global.autoCheckUpdates = pickBoolean(g['autoCheckUpdates'], base.global.autoCheckUpdates);
	base.global.notificationsEnabled = pickBoolean(
		g['notificationsEnabled'],
		base.global.notificationsEnabled
	);
	base.global.showUnreadBadge = pickBoolean(g['showUnreadBadge'], base.global.showUnreadBadge);
	base.global.startupWorkspaceId =
		typeof g['startupWorkspaceId'] === 'string' ? g['startupWorkspaceId'] : null;

	const ws = r['workspaces'];
	if (typeof ws === 'object' && ws !== null) {
		for (const [id, value] of Object.entries(ws as Record<string, unknown>)) {
			if (typeof value !== 'object' || value === null) continue;
			const v = value as Record<string, unknown>;
			base.workspaces[id] = {
				muteNotifications: pickBoolean(v['muteNotifications'], false),
			};
		}
	}

	return base;
}
