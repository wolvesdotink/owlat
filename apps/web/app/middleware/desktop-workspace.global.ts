/**
 * Desktop pre-auth gate.
 *
 * On the desktop runtime, route to /desktop/welcome until a workspace is active.
 * No-op on web and on the desktop connect/welcome screens themselves. Runs ahead
 * of `feature.global` / `setup.global` (alphabetical) and before the named
 * `auth` middleware, so we never try to resolve a session against a
 * non-existent workspace.
 */
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

const ALLOWED_PREFIXES = ['/desktop/welcome', '/desktop/connect', '/desktop/setup'];

export default defineNuxtRouteMiddleware((to) => {
	if (import.meta.server) return;
	if (!isDesktopRuntime()) return;
	if (ALLOWED_PREFIXES.some((p) => to.path.startsWith(p))) return;

	const { active } = useDesktopWorkspaces();
	if (!active.value) {
		return navigateTo('/desktop/welcome');
	}

	// `/` is both the packaged app's entry document (what the Tauri webview
	// loads on every launch) and the web marketing landing. With a workspace
	// active, the landing would render inside the desktop shell with no
	// workspace chrome at all — no rail, no switcher, no way into the product.
	// Desktop always enters the app itself.
	if (to.path === '/') {
		return navigateTo('/dashboard');
	}
});
