/**
 * Save the current page, then open another app page "in a new tab".
 *
 * In a browser the tab has to be opened synchronously inside the click gesture:
 * a `window.open()` deferred until after the awaited save is out of the gesture
 * context and most popup blockers swallow it. So a blank tab opens first, its
 * opener is cleared (to match `noopener`), and it is pointed at the URL once the
 * save resolves — or closed if the save fails.
 *
 * The desktop app has no tabs, and that blank tab never works there: macOS and
 * Linux refuse the `about:blank` popup (the tab is `null`), and Windows opens a
 * bare WebView2 window outside the bundled app, where the route never loads
 * (apps/desktop/src-tauri/src/links.rs). There the page is saved and then
 * navigated to in the same window, as every other app link does on desktop.
 *
 * Resolves `true` when the save succeeded and the page was opened.
 */
interface OpenAfterSaveOptions {
	/** App route to open, e.g. `/dashboard/send/emails/<id>/edit`. */
	url: string;
	/** Persist the current page; resolves `false` on failure. */
	save: () => Promise<boolean>;
	/** Running inside the Tauri desktop shell. */
	isDesktop: boolean;
	/** In-app navigation (`navigateTo`), used on desktop. */
	navigate: (url: string) => unknown;
	/** `window.open`, injectable for tests. */
	openWindow?: (url: string, target: string) => Window | null;
}

export async function openAfterSave(options: OpenAfterSaveOptions): Promise<boolean> {
	const { url, save, isDesktop, navigate } = options;

	if (isDesktop) {
		if (!(await save())) return false;
		await navigate(url);
		return true;
	}

	const openWindow = options.openWindow ?? ((u, target) => window.open(u, target));
	const tab = openWindow('', '_blank');
	if (tab) tab.opener = null;
	if (!(await save())) {
		tab?.close();
		return false;
	}
	if (tab) tab.location.href = url;
	return true;
}

interface OpenWithoutSavingOptions {
	/** App route to open. */
	url: string;
	/** Running inside the Tauri desktop shell. */
	isDesktop: boolean;
	/**
	 * Drop the unsaved edits. Called before the desktop navigation so the page's
	 * own leave guard does not ask a second time.
	 */
	discard: () => void;
	/** In-app navigation (`navigateTo`), used on desktop. */
	navigate: (url: string) => unknown;
	/** `window.open`, injectable for tests. */
	openWindow?: (url: string, target: string, features: string) => Window | null;
}

/**
 * Open another app page without saving: a new tab in a browser (the current
 * page keeps its unsaved edits), an in-app navigation on desktop (which leaves
 * the page, so the edits are discarded first).
 */
export async function openWithoutSaving(options: OpenWithoutSavingOptions): Promise<void> {
	const { url, isDesktop, discard, navigate } = options;
	if (isDesktop) {
		discard();
		await navigate(url);
		return;
	}
	const openWindow =
		options.openWindow ?? ((u, target, features) => window.open(u, target, features));
	openWindow(url, '_blank', 'noopener');
}
