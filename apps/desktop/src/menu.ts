/**
 * Application-menu bridge.
 *
 * The Rust application menu (menu.rs) emits `menu://<action>` Tauri events for
 * app-level items; this exposes a typed subscription the SPA wires onto its
 * router (see apps/web useDesktopMenu.ts). Navigation items (Inbox/Chat/Reload)
 * and external links (Docs/Report) are handled entirely in Rust. Mirrors
 * shortcuts.ts. No-op outside Tauri.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type MenuAction = 'preferences' | 'new-workspace' | 'check-updates';

export async function onMenuAction(action: MenuAction, cb: () => void): Promise<UnlistenFn> {
	return listen(`menu://${action}`, () => cb());
}
