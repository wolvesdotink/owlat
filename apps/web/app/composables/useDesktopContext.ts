/**
 * Composable for detecting and interacting with the Tauri desktop environment.
 *
 * When running inside the Tauri webview, `window.__TAURI_INTERNALS__` is always
 * injected (`__TAURI__` additionally exists only with `app.withGlobalTauri`,
 * which we don't enable — the app imports `@tauri-apps/api` directly). Same
 * check as `lib/desktop/activeWorkspace.ts`.
 * This composable gates all desktop-specific UI and behavior behind that check.
 */
export function useDesktopContext() {
	const isDesktop = computed(
		() => typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
	);

	const isMac = computed(
		() => isDesktop.value && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
	);

	const isWindows = computed(
		() => isDesktop.value && typeof navigator !== 'undefined' && /Win/.test(navigator.platform)
	);

	const isLinux = computed(
		() => isDesktop.value && !isMac.value && !isWindows.value
	);

	return {
		isDesktop,
		isMac,
		isWindows,
		isLinux,
	};
}
