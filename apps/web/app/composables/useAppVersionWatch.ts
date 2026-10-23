/**
 * The tab's one version watch (see `lib/appVersion.ts`), wired to the browser.
 * Null where it does not apply: in development (HMR replaces code in place),
 * in the desktop app (its bundle ships with the app and updates through the
 * desktop updater, not from this server) and for a build without an id.
 */
import { useRouter } from 'vue-router';
import { createAppVersionWatch, isComparableBuildId, type AppVersionWatch } from '~/lib/appVersion';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { settleForReload } from '~/lib/reloadSafety';

/** A check the server has not answered by then counts as failed. */
const FETCH_TIMEOUT_MS = 10_000;

let watch: AppVersionWatch | null = null;

function sessionStore(): Storage | null {
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

export function useAppVersionWatch(): AppVersionWatch | null {
	if (watch) return watch;
	const config = useRuntimeConfig();
	const bootBuildId: unknown = config.app.buildId;
	if (import.meta.dev || isDesktopRuntime() || !isComparableBuildId(bootBuildId)) return null;
	const endpoint = `${config.app.baseURL.replace(/\/+$/, '')}/api/app-version`;
	watch = createAppVersionWatch({
		bootBuildId,
		fetchDeployed: async () => {
			const response = await fetch(endpoint, {
				cache: 'no-store',
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			return response.ok ? await response.json() : null;
		},
		router: useRouter(),
		settleForReload,
		assign: (href) => window.location.assign(href),
		reload: () => window.location.reload(),
		storage: sessionStore(),
		isVisible: () => document.visibilityState === 'visible',
	});
	return watch;
}
