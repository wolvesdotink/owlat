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
 *     id (notification mute, the mailbox the tray counts). Server-side
 *     workspace settings stay in Convex and are NOT mirrored here.
 *
 * The store is read with `normalizeDesktopSettings`, which merges any raw
 * value over the defaults — a missing, corrupt, or older-versioned file can
 * never throw or surface partial state.
 */

export const SETTINGS_VERSION = 1;

export interface GlobalDesktopSettings {
	/** Run the non-blocking update check on app boot. Manual checks always work. */
	autoCheckUpdates: boolean;
	/** Master switch for native notification toasts (badge is separate). */
	notificationsEnabled: boolean;
	/** Show the unread-count badge on the dock/taskbar icon. */
	showUnreadBadge: boolean;
	/**
	 * Show the tray icon (the menu bar extra on macOS). The Rust shell also
	 * reads this key from the file at launch (src-tauri tray.rs).
	 */
	showTrayIcon: boolean;
	/**
	 * Windows and Linux: closing the main window hides it to the tray icon
	 * instead of quitting. macOS always hides it. Also read by tray.rs.
	 */
	closeToTray: boolean;
	/**
	 * macOS: leave the Dock and run from the menu bar icon alone. Applies only
	 * while `showTrayIcon` is on, since nothing else could bring the app back.
	 * Also read by tray.rs.
	 */
	hideDockIcon: boolean;
	/** Workspace to activate on a cold app launch; null = last active. */
	startupWorkspaceId: string | null;
}

/** Device-local per-workspace preferences (keyed by workspace id). */
export interface WorkspaceLocalSettings {
	/** Suppress notification toasts while this workspace is active. */
	muteNotifications: boolean;
	/**
	 * The one mailbox the tray icon counts and lists, or null for all inboxes.
	 * Per workspace because a mailbox id belongs to one workspace's backend.
	 */
	trayMailboxId: string | null;
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
			showTrayIcon: true,
			closeToTray: true,
			hideDockIcon: false,
			startupWorkspaceId: null,
		},
		workspaces: {},
	};
}

export function defaultWorkspaceLocalSettings(): WorkspaceLocalSettings {
	return { muteNotifications: false, trayMailboxId: null };
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
	base.global.showTrayIcon = pickBoolean(g['showTrayIcon'], base.global.showTrayIcon);
	base.global.closeToTray = pickBoolean(g['closeToTray'], base.global.closeToTray);
	base.global.hideDockIcon = pickBoolean(g['hideDockIcon'], base.global.hideDockIcon);
	base.global.startupWorkspaceId =
		typeof g['startupWorkspaceId'] === 'string' ? g['startupWorkspaceId'] : null;

	const ws = r['workspaces'];
	if (typeof ws === 'object' && ws !== null) {
		for (const [id, value] of Object.entries(ws as Record<string, unknown>)) {
			if (typeof value !== 'object' || value === null) continue;
			const v = value as Record<string, unknown>;
			base.workspaces[id] = {
				muteNotifications: pickBoolean(v['muteNotifications'], false),
				trayMailboxId:
					typeof v['trayMailboxId'] === 'string' && v['trayMailboxId'] !== ''
						? v['trayMailboxId']
						: null,
			};
		}
	}

	return base;
}
