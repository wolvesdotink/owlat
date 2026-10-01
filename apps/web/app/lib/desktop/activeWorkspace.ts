/**
 * Synchronously-readable active-workspace singleton.
 *
 * `auth-client.ts` and `convex.client.ts` build their clients synchronously and
 * cannot await anything, so they read the active workspace from here. The async
 * boot plugin (`plugins/0.desktop-workspace.client.ts`) populates it before
 * either client is built, and a workspace switch reloads the whole webview — so
 * this value is stable for the lifetime of a page load.
 */
import type { WorkspaceConfig } from './workspaceTypes';

let active: WorkspaceConfig | null = null;

/**
 * True when running inside the Tauri webview. Checked live (the global is stable
 * for the page lifetime). Mirrors `useDesktopContext`, plus the v2 internals
 * global in case `withGlobalTauri` is off.
 */
export function isDesktopRuntime(): boolean {
	if (import.meta.server) return false;
	return '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
}

export function getActiveWorkspace(): WorkspaceConfig | null {
	return active;
}

export function setActiveWorkspace(ws: WorkspaceConfig | null): void {
	active = ws;
}
