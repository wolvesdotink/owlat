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
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { loadWorkspaces } from '~/composables/useDesktopWorkspaces';
import { setupDeepLinks } from '~/lib/desktop/deepLink.client';
import { setupUpdateChecks } from '~/lib/desktop/updater.client';

export default defineNuxtPlugin({
	name: 'owlat:desktop-workspace',
	enforce: 'pre',
	async setup() {
		if (!isDesktopRuntime()) return;

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
		// Non-blocking: deep links can arrive any time after boot.
		void setupDeepLinks();
		// Non-blocking auto-update check (+ a manual `owlat:check-updates` trigger).
		setupUpdateChecks();
	},
});
