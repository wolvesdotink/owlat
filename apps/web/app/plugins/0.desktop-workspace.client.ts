/**
 * Desktop boot plugin — runs FIRST (the `0.` filename prefix + `enforce: 'pre'`
 * order it ahead of `convex.client.ts`).
 *
 * On the desktop runtime it awaits the active workspace + its keychain session
 * so that, by the time `convex.client.ts` builds the Convex client and the first
 * auth call builds the auth client, the active workspace URLs and stored token
 * are in place. Importing a module is not enough to wait on: every plugin file
 * is imported before any plugin runs, which is why `auth-client.ts` builds its
 * client on first use rather than at import.
 * Then it wires up deep-link handling (including the `owlat://auth` sign-in
 * return). Outside Tauri it is an immediate no-op, so web behavior is unchanged.
 *
 * The boot itself lives in `lib/desktop/desktopBoot.client.ts` and is imported
 * only after the runtime check: this file is in the boot bundle of every
 * browser, and a static import here would ship the workspace manager, deep
 * links and the updater to all of them. The check stays synchronous, and the
 * plugin awaits the whole boot, so the ordering above holds across the import.
 */
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
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

		const { bootDesktop } = await import('~/lib/desktop/desktopBoot.client');
		await bootDesktop(nuxtApp);
	},
});
