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
import { setupDeepLinks } from '~/lib/desktop/deepLink.client';
import { setupUpdateChecks } from '~/lib/desktop/updater.client';

export default defineNuxtPlugin({
	name: 'owlat:desktop-workspace',
	enforce: 'pre',
	async setup(nuxtApp) {
		if (!isDesktopRuntime()) return;

		// Perceived-instant switch (piece d4): if we arrived here via a workspace
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
		// Complements the .dark/.light color-mode class; kept consistent with
		// useDesktopContext.ts's navigator.platform detection.
		const root = document.documentElement;
		root.classList.add('is-desktop');
		const platform = navigator.platform || '';
		if (/Mac/i.test(platform)) root.classList.add('is-mac');
		else if (/Win/i.test(platform)) root.classList.add('is-win');
		else root.classList.add('is-linux');

		await loadWorkspaces();

		// Paint the active workspace's identity accent BEFORE first render (the
		// switch/restart path reloads the webview, so reading it here — after the
		// awaited load — avoids an un-accented flash). The chrome derives every
		// tint from this one custom property via color-mix in desktop.css.
		applyWorkspaceAccent(root, getActiveWorkspace()?.accentColor ?? null);

		// Collapse the identity frame in native fullscreen — both the CSS ring
		// (win/linux, via the class) and the native macOS ring (out of CSS reach,
		// via the bridge). Best-effort: if the window bridge is unavailable the
		// frame simply stays painted.
		void import('@owlat/desktop/src/window')
			.then(({ watchFullscreen, setAccentFrameVisible }) =>
				watchFullscreen((fullscreen) => {
					root.classList.toggle('ws-fullscreen', fullscreen);
					void setAccentFrameVisible(!fullscreen).catch(() => {});
				})
			)
			.catch(() => {});

		// Non-blocking: deep links can arrive any time after boot.
		void setupDeepLinks();
		// Non-blocking auto-update check (+ a manual `owlat:check-updates` trigger).
		setupUpdateChecks();
	},
});
