/**
 * Composable for detecting and interacting with the Tauri desktop environment.
 *
 * When running inside the Tauri webview, `window.__TAURI_INTERNALS__` is always
 * injected (`__TAURI__` additionally exists only with `app.withGlobalTauri`,
 * which we don't enable — the app imports `@tauri-apps/api` directly). Same
 * check as `lib/desktop/activeWorkspace.ts`.
 * This composable gates all desktop-specific UI and behavior behind that check.
 *
 * Platform detection is NOT spelled here: it comes from
 * `lib/desktop/platform.ts`, the one module that reads it, so the titlebar
 * chrome, the OS notification deep link, the "default mail app" instructions and
 * the ⌘-vs-Ctrl hint can never disagree about which OS this is.
 */
import { readDesktopPlatform, type DesktopPlatform } from '~/lib/desktop/platform';

export function useDesktopContext() {
	const isDesktop = computed(
		() =>
			typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
	);

	/**
	 * The operating system, REGARDLESS of runtime — a browser on a Mac still
	 * wants ⌘ in its shortcut hints. Use `isMac`/`isWindows`/`isLinux` for the
	 * desktop-app-only chrome.
	 */
	const platform = computed<DesktopPlatform>(() => readDesktopPlatform());

	const isMac = computed(() => isDesktop.value && platform.value === 'mac');
	const isWindows = computed(() => isDesktop.value && platform.value === 'windows');
	const isLinux = computed(() => isDesktop.value && platform.value === 'linux');

	return {
		isDesktop,
		platform,
		isMac,
		isWindows,
		isLinux,
	};
}
