/**
 * Window-controls + window-effects bridge for the desktop chrome.
 *
 * The custom titlebar (Windows/Linux) drives minimize / maximize / close through
 * here; macOS uses the native traffic lights plus the declarative
 * `data-tauri-drag-region`, so it needs none of these control calls. Vibrancy
 * (macOS) / Mica (Windows 11) is applied at runtime so it can be scoped to the
 * sidebar and killed without a rebuild.
 *
 * Mirrors the thin try/catch bridge style of notifications.ts. No-op outside Tauri.
 */
import { getCurrentWindow, Effect } from '@tauri-apps/api/window';

export async function startDragging(): Promise<void> {
	await getCurrentWindow().startDragging();
}

export async function minimizeWindow(): Promise<void> {
	await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
	await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
	// Hits the Rust CloseRequested handler → hides to tray (window.rs).
	await getCurrentWindow().close();
}

export async function isWindowMaximized(): Promise<boolean> {
	return getCurrentWindow().isMaximized();
}

/**
 * Apply the native window material: macOS → `sidebar` (Finder/Mail vibrancy),
 * Windows 11 → `mica`. Requires `transparent: true` on the window. Rejects on
 * platforms/versions without support (e.g. Windows 10) — callers treat that as
 * "stay solid" and never flip the CSS that reveals the material.
 */
export async function applyVibrancy(material: 'sidebar' | 'mica'): Promise<void> {
	const effect = material === 'mica' ? Effect.Mica : Effect.Sidebar;
	await getCurrentWindow().setEffects({ effects: [effect] });
}

export async function clearVibrancy(): Promise<void> {
	await getCurrentWindow().clearEffects();
}

/**
 * Watch native window fullscreen state and invoke `onChange` whenever it flips.
 * Native (green-button) fullscreen does not fire the DOM `:fullscreen` event, so
 * the desktop chrome relies on this to collapse the identity frame. Fires once
 * immediately with the current state, then re-checks on every resize (fullscreen
 * toggles emit a resize). Returns an unlisten fn. No-op safety outside Tauri.
 */
export async function watchFullscreen(
	onChange: (fullscreen: boolean) => void
): Promise<() => void> {
	const win = getCurrentWindow();
	let last = await win.isFullscreen();
	onChange(last);

	// Each resize tick issues its own async isFullscreen() query; during the
	// macOS fullscreen transition's resize burst several can be in flight and
	// resolve out of order. A monotonic token makes it last-call-wins (stale
	// resolutions are dropped) and we only notify on an actual change.
	let latest = 0;
	return win.onResized(async () => {
		const token = ++latest;
		const value = await win.isFullscreen();
		if (token !== latest) return; // a newer query superseded this one
		if (value === last) return; // unchanged — nothing to notify
		last = value;
		onChange(value);
	});
}
