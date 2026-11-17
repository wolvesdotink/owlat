/**
 * Where the desktop app sends someone for a control that only the instance can
 * run.
 *
 * The desktop app ships the web app as a static build with no Nitro server
 * routes (`apps/web/server/api/`), so a control that posts to one (the update
 * run, the services apply, the port checks, the transport editor) cannot work
 * there. On desktop such a control is not offered: the surface says the work
 * happens on the instance and opens the same page on the instance in the
 * system browser. What Convex serves keeps working on desktop.
 */
import { ref } from 'vue';
import { getActiveWorkspace, isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

/** `path` on the connected instance's web origin, or `null` when that is unknown. */
function instanceUrl(path: string): string | null {
	const siteUrl = getActiveWorkspace()?.siteUrl;
	if (!siteUrl) return null;
	try {
		return new URL(path, siteUrl).href;
	} catch {
		return null;
	}
}

export function useInstancePage(path: string) {
	// Stable for the page load: the runtime and the active workspace only change
	// with a reload.
	const isDesktop = isDesktopRuntime();
	const url = isDesktop ? instanceUrl(path) : null;
	/** Set when the shell refused to open the browser, so the page can print the address. */
	const openFailed = ref(false);

	async function openInBrowser(): Promise<void> {
		if (url === null) return;
		try {
			const { openExternal } = await import('@owlat/desktop/src/shell');
			await openExternal(url);
			openFailed.value = false;
		} catch {
			openFailed.value = true;
		}
	}

	return { isDesktop, url, openFailed, openInBrowser };
}
