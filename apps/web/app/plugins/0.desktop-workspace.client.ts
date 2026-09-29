/**
 * Desktop boot plugin — runs FIRST (the `0.` filename prefix + `enforce: 'pre'`
 * order it ahead of `convex.client.ts`).
 *
 * On the desktop runtime it awaits the active workspace + its keychain session
 * so that, by the time `convex.client.ts` and `auth-client.ts` are first
 * imported, the active workspace URLs and stored token are already in place.
 * Then it wires up deep-link handling (including the `owlat://auth` sign-in
 * return). Outside Tauri it is an immediate no-op, so web behavior is unchanged.
 */
import { getActiveWorkspace, isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { loadWorkspaces } from '~/composables/useDesktopWorkspaces';
import { applyWorkspaceAccent } from '~/lib/desktop/workspaceAccent';
import {
	clearSwitchFlag,
	hideSwitchSkeleton,
	readSwitchFlag,
	showSwitchSkeleton,
	SWITCH_FLAG_TTL_MS,
} from '~/lib/desktop/workspaceSwitch';
import { PLATFORM_ROOT_CLASS, readDesktopPlatform } from '~/lib/desktop/platform';
import { setupDeepLinks } from '~/lib/desktop/deepLink.client';
import { setupUpdateChecks } from '~/lib/desktop/updater.client';
import { afterSplashPaint } from '~/lib/desktop/splashPaint';
import { installNativeFeel } from '~/lib/desktop/nativeFeel.client';
import type { Router } from 'vue-router';

declare global {
	interface Window {
		/**
		 * The SPA router, exposed on the desktop runtime so the native application
		 * menu (src-tauri `window::navigate_to`) can push routes client-side
		 * instead of forcing a full document reload. Undefined on the web and
		 * before the desktop boot plugin runs.
		 */
		__NUXT_ROUTER__?: Router;
	}
}

/**
 * The "Open at startup" workspace pin from the device settings, for the main
 * window only; null when there is none or the settings cannot be read (the
 * last-active workspace then opens, as before).
 */
async function readStartupWorkspacePin(): Promise<string | null> {
	try {
		const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
		if (getCurrentWebviewWindow().label !== 'main') return null;
		const { loadDesktopAppSettings } = await import('~/composables/useDesktopAppSettings');
		return (await loadDesktopAppSettings()).global.startupWorkspaceId;
	} catch {
		return null;
	}
}

export default defineNuxtPlugin({
	name: 'owlat:desktop-workspace',
	enforce: 'pre',
	async setup(nuxtApp) {
		if (!isDesktopRuntime()) return;

		// Expose the SPA router to the native side. The application menu
		// (src-tauri window::navigate_to) prefers `window.__NUXT_ROUTER__.push(...)`
		// so File → Inbox / Chat is an instant client-side route change instead of a
		// full document reload; without this the native menu falls back to a
		// location assignment (a cold re-boot). Desktop-only — never touches web.
		window.__NUXT_ROUTER__ = nuxtApp['$router'] as Router;

		// Perceived-instant switch: if we arrived here via a workspace
		// switch, re-paint its skeleton FIRST — before Nuxt mounts — so the reload
		// replaces like with like instead of flashing bg-base. A stale flag (reload
		// that never landed within the TTL) is discarded rather than shown. The
		// skeleton crossfades away on first app paint, with a hard TTL fallback so
		// it can never get stuck if that hook never fires.
		const pendingSwitch = readSwitchFlag(sessionStorage, Date.now());
		clearSwitchFlag(sessionStorage);
		if (pendingSwitch) {
			const skeleton = showSwitchSkeleton(pendingSwitch.accent, pendingSwitch.label);
			nuxtApp.hook('app:mounted', () => hideSwitchSkeleton(skeleton));
			window.setTimeout(() => hideSwitchSkeleton(skeleton), SWITCH_FLAG_TTL_MS);
		}

		// Platform hooks on <html> for native-chrome CSS (titlebar, vibrancy).
		// Complements the .dark/.light color-mode class. Same detection as
		// `useDesktopContext`, because it is the same module.
		const root = document.documentElement;
		root.classList.add('is-desktop');
		root.classList.add(PLATFORM_ROOT_CLASS[readDesktopPlatform()]);

		// Native-window behaviour: no browser context menu on app chrome, the
		// macOS title-bar double-click setting, the zoom factor for the chrome.
		// Dev builds keep the context menu for Inspect Element.
		installNativeFeel({
			isMac: readDesktopPlatform() === 'mac',
			keepContextMenu: import.meta.dev,
		});

		// The native window bridge, loaded once for the reveal and the
		// fullscreen watcher below.
		const windowBridge = import('@owlat/desktop/src/window');

		// Every window is built hidden (src-tauri window::arm_reveal) so launch
		// never flashes an empty, see-through frame. Show it as soon as the opaque
		// SPA splash has painted, not after the boot chain below and the app
		// mount: the splash is the loading state, and `.is-desktop` (set above)
		// already keeps the page background opaque. `app:mounted` stays as a
		// second trigger. The native side shows a window once, so the later
		// call, and every call after a workspace switch reload, is a no-op.
		const reveal = () => {
			void windowBridge.then(({ windowReady }) => windowReady()).catch(() => {});
		};
		void afterSplashPaint().then(reveal);
		nuxtApp.hook('app:mounted', reveal);

		// "Open at startup" workspace pin (from /desktop/settings). Applied only on
		// a COLD launch of the MAIN window: workspace switches reload this webview
		// (re-applying the pin there would bounce every switch back to it), and
		// secondary windows like compose have their own fresh sessionStorage, so
		// without the label guard they'd read as "cold" and clobber the active
		// workspace mid-session. sessionStorage survives reloads but not an app
		// restart, so a missing marker is exactly "cold launch".
		const BOOT_MARKER = 'owlat:booted';
		const coldLaunch = !sessionStorage.getItem(BOOT_MARKER);
		sessionStorage.setItem(BOOT_MARKER, '1');
		// Not awaited here: loadWorkspaces reads the settings and the workspace
		// store at the same time and applies the pin once both are in.
		const preferredActiveId = coldLaunch ? readStartupWorkspacePin() : null;

		// Dev-only auto-connect: `tauri dev` loads the local Nuxt dev server, so
		// seed the page's own origin as a workspace instead of making the
		// developer run the manual connect handshake on every fresh profile.
		await loadWorkspaces({ seedLocalDev: import.meta.dev, preferredActiveId });

		// Paint the active workspace's identity accent BEFORE first render (the
		// switch/restart path reloads the webview, so reading it here — after the
		// awaited load — avoids an un-accented flash). The chrome derives every
		// tint from this one custom property via color-mix in desktop.css.
		applyWorkspaceAccent(root, getActiveWorkspace()?.accentColor ?? null);

		// Collapse the identity frame in native fullscreen — both the CSS ring
		// (win/linux, via the class) and the native macOS ring (out of CSS reach,
		// via the bridge). Best-effort: if the window bridge is unavailable the
		// frame simply stays painted.
		void windowBridge
			.then(({ watchFullscreen, setAccentFrameVisible }) =>
				watchFullscreen((fullscreen) => {
					root.classList.toggle('ws-fullscreen', fullscreen);
					void setAccentFrameVisible(!fullscreen).catch(() => {});
				})
			)
			.catch(() => {});

		// Non-blocking: deep links can arrive any time after boot.
		void setupDeepLinks();
		// Auto-update check, delayed past the launch (+ a manual
		// `owlat:check-updates` trigger). Gates itself to the main window: the
		// compose webview boots this plugin too, and must not run a second
		// updater against the shared native slot.
		setupUpdateChecks();
	},
});
