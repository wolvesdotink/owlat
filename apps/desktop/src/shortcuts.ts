/**
 * Global-shortcut bridge.
 *
 * The Rust side registers the system-wide accelerators and emits `shortcut://<name>`
 * Tauri events; this exposes a typed subscription the SPA wires onto its existing
 * in-app shortcut handling.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// `compose` and window-toggle are handled entirely in Rust; only quick-switcher
// is forwarded to the SPA.
export type ShortcutName = 'quick-switcher';

export async function onShortcut(name: ShortcutName, cb: () => void): Promise<UnlistenFn> {
	return listen(`shortcut://${name}`, () => cb());
}
