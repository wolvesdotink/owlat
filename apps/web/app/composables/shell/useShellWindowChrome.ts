/**
 * The desktop app's native window around the dashboard shell: the window
 * material behind the sidebar and the macOS traffic lights that follow it.
 * Both are no-ops on the web and wherever Tauri is unavailable.
 */
import type { Ref } from 'vue';

export function useShellWindowChrome(options: {
	isDesktop: Readonly<Ref<boolean>>;
	isMac: Readonly<Ref<boolean>>;
	isWindows: Readonly<Ref<boolean>>;
	/** The sidebar is hidden (desktop breakpoint). */
	effectiveHidden: Readonly<Ref<boolean>>;
	/** The hidden sidebar is peeking over the content. */
	isPeeking: Readonly<Ref<boolean>>;
}) {
	const { isDesktop, isMac, isWindows, effectiveHidden, isPeeking } = options;

	// Native window material (macOS vibrancy / Windows 11 Mica). Behind a single flag
	// so it can be killed without a config rebuild; the branded chrome and menus do
	// not depend on it. The `.vibrancy-on` class (added only on success) gates the CSS
	// in assets/css/desktop.css that makes the sidebar translucent — so an unsupported
	// platform (e.g. Windows 10) can never reveal the desktop wallpaper.
	const ENABLE_VIBRANCY = true;
	onMounted(async () => {
		if (!ENABLE_VIBRANCY || !isDesktop.value || !(isMac.value || isWindows.value)) return;
		try {
			const { applyVibrancy } = await import('@owlat/desktop/src/window');
			await applyVibrancy(isWindows.value ? 'mica' : 'sidebar');
			document.documentElement.classList.add('vibrancy-on');
		} catch {
			// Unsupported (e.g. Windows 10) or Tauri unavailable — solid theme stays.
		}
	});

	// Native macOS traffic lights follow the sidebar (desktop + macOS only). They
	// stay visible whenever the rail — or its transient peek overlay — is on screen,
	// and hide only when the sidebar is fully hidden and not peeking. Wired at mount
	// (after the webview is ready) with an immediate sync, so the buttons are never
	// stranded: a fresh launch with a persisted-hidden sidebar re-hides them, and
	// un-hiding the rail always brings them back.
	//
	// Fullscreen: macOS owns the buttons in native fullscreen (they live in the
	// auto-revealed menu bar), so we restore them to visible on enter — don't fight
	// the OS — and re-apply the sidebar-derived state on exit, since Cmd-\ toggles
	// that happen inside fullscreen are dropped by the native guard and would
	// otherwise leave the lights stale (visible with the rail hidden).
	//
	// Unmount: leaving this layout with the sidebar hidden (sign-out, session
	// expiry → login) would strand the window with no close/miniaturize/zoom
	// buttons on a surface that has no rail or peek to bring them back, so restore
	// them whenever the sidebar-owning layout is torn down.
	onMounted(() => {
		if (!isDesktop.value || !isMac.value) return;

		let unlistenFullscreen: (() => void) | null = null;
		let isFullscreen = false;

		// Reflect the current sidebar/peek state to the native buttons, unless the
		// window is in fullscreen (macOS owns them there — leave native behavior).
		const applySidebarState = async () => {
			if (isFullscreen) return;
			try {
				const { setTrafficLightsVisible, trafficLightsVisibleFor } =
					await import('@owlat/desktop/src/window');
				await setTrafficLightsVisible(
					trafficLightsVisibleFor(effectiveHidden.value, isPeeking.value)
				);
			} catch {
				// Tauri unavailable — native buttons stay as-is.
			}
		};

		watch([effectiveHidden, isPeeking], applySidebarState, { immediate: true });

		void (async () => {
			try {
				const { setTrafficLightsVisible, watchFullscreen } =
					await import('@owlat/desktop/src/window');
				unlistenFullscreen = await watchFullscreen((fullscreen) => {
					isFullscreen = fullscreen;
					if (fullscreen) {
						// Restore the buttons so the native fullscreen reveal bar shows the
						// green-button exit affordance; the native side then owns them.
						void setTrafficLightsVisible(true);
					} else {
						// Back to windowed — re-derive from the (possibly changed) sidebar.
						void applySidebarState();
					}
				});
			} catch {
				// Tauri unavailable — fullscreen tracking is a no-op.
			}
		})();

		onUnmounted(async () => {
			unlistenFullscreen?.();
			try {
				const { setTrafficLightsVisible } = await import('@owlat/desktop/src/window');
				await setTrafficLightsVisible(true);
			} catch {
				// Tauri unavailable — nothing to restore.
			}
		});
	});
}
