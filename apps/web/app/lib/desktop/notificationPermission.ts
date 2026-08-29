/**
 * Where the OS keeps the switch the app cannot flip.
 *
 * A refused notification permission is final as far as the app is concerned —
 * neither the Tauri plugin nor the browser will prompt a second time — so the
 * only honest recovery is to send the user to the right settings pane. macOS
 * and Windows both expose a deep link for it; on Linux the pane depends on the
 * desktop environment (GNOME, KDE, Xfce all differ), so we say where to look
 * instead of guessing a URI that would fail silently.
 *
 * Both URIs are allow-listed in the plugin-shell `open` scope
 * (`apps/desktop/src-tauri/tauri.conf.json`), which otherwise only permits
 * mailto/tel/http(s).
 *
 * Pure and platform-parameterised so it unit-tests without a webview. WHICH
 * platform is not decided here — `lib/desktop/platform.ts` is the one module
 * that reads the navigator.
 */
import type { DesktopPlatform } from './platform';

export type { DesktopPlatform };

/**
 * The deep link that opens the OS notification settings, or null when the
 * platform has no single one. Callers render the null case as instructions.
 */
export function osNotificationSettingsUri(platform: DesktopPlatform): string | null {
	switch (platform) {
		case 'mac':
			// The Notifications pane of System Settings (System Preferences pre-13).
			return 'x-apple.systempreferences:com.apple.preference.notifications';
		case 'windows':
			return 'ms-settings:notifications';
		case 'linux':
			return null;
	}
}
