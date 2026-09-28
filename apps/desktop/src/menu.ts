/**
 * Application-menu bridge.
 *
 * The Rust application menu (menu.rs) emits `menu://<action>` Tauri events for
 * app-level items; this exposes a typed subscription the SPA wires onto its
 * router (see apps/web plugins/1.desktop-menu.client.ts — registered app-wide
 * so the menu also works before a workspace is connected). Navigation items
 * (Inbox/Chat/Reload/Back/Forward), zoom and external links (Docs/Report) are
 * handled entirely in Rust. Mirrors shortcuts.ts. No-op outside Tauri.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type MenuAction = 'preferences' | 'new-workspace' | 'check-updates' | 'find';

export async function onMenuAction(action: MenuAction, cb: () => void): Promise<UnlistenFn> {
	return listen(`menu://${action}`, () => cb());
}

/**
 * A `mailto:` link was clicked inside an Owlat window. The Rust link policy
 * (links.rs) keeps it from reaching the OS — which might open another mail
 * client — and hands the raw URL to the main window instead.
 */
export async function onOpenMailto(cb: (url: string) => void): Promise<UnlistenFn> {
	return listen<string>('link://mailto', (e) => cb(e.payload));
}
