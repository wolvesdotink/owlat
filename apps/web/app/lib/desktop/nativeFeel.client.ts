/**
 * Desktop-only behaviour that makes the webview act like a native window
 * rather than a web page inside one. Installed once per window by the desktop
 * boot plugin; the look-and-feel half (no selectable chrome, arrow cursor, no
 * rubber-banding) lives in assets/css/desktop.css.
 *
 *   - Context menu: right-clicking app chrome no longer opens the webview's
 *     browser menu (Reload / Back / Inspect Element / Save Page As). It stays
 *     where it is useful — text fields (spelling, paste), a text selection
 *     (copy, look up) and external links (copy link). Surfaces with their own
 *     menu (thread rows, folders, labels) already call preventDefault, which is
 *     respected. Dev builds keep it everywhere for Inspect Element.
 *   - Title-bar double-click (macOS): the stock drag region always toggles
 *     maximize; a native title bar follows the "Double-click a window's title
 *     bar to" system setting. The double-click is routed to the native side,
 *     which reads that setting.
 *   - Page zoom: `--native-zoom` on <html> mirrors the View-menu zoom so chrome
 *     that has to line up with native pixels (the traffic-light gutter) can
 *     divide the zoom back out.
 */

const DRAG_REGION_ATTR = 'data-tauri-drag-region';

/** CSS custom property carrying the page zoom factor (1 = 100%). */
export const NATIVE_ZOOM_VAR = '--native-zoom';

/**
 * Whether a right-click should still get the webview's own context menu.
 * `origin` is the app's own origin: in-app links have nothing useful to copy.
 */
export function keepsDefaultContextMenu(
	target: EventTarget | null,
	selectedText: string,
	origin: string
): boolean {
	if (selectedText.trim().length > 0) return true;
	if (!(target instanceof Element)) return false;
	if (target.closest('input, textarea, select')) return true;
	if (target instanceof HTMLElement && target.isContentEditable) return true;
	const link = target.closest('a[href]');
	if (link) {
		try {
			const url = new URL(link.getAttribute('href') ?? '', origin);
			if (url.protocol === 'mailto:') return true;
			return /^https?:$/.test(url.protocol) && url.origin !== origin;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * The same "is this a title-bar double-click" test Tauri's drag-region script
 * applies (the attribute on the event target itself, primary button, second
 * click), so we claim exactly the events it would otherwise turn into a
 * maximize toggle.
 */
export function isDragRegionDoubleClick(event: MouseEvent): boolean {
	if (event.button !== 0 || event.detail !== 2) return false;
	const target = event.target;
	if (!(target instanceof Element)) return false;
	const attr = target.getAttribute(DRAG_REGION_ATTR);
	return attr !== null && attr !== 'false';
}

/** Mirror the page zoom factor onto <html>. */
export function applyNativeZoom(root: HTMLElement, factor: number): void {
	root.style.setProperty(NATIVE_ZOOM_VAR, String(factor > 0 ? factor : 1));
}

export interface NativeFeelOptions {
	/** macOS: route title-bar double-clicks to the system setting. */
	isMac: boolean;
	/** Keep the webview context menu everywhere (dev builds: Inspect Element). */
	keepContextMenu: boolean;
}

/** Install the listeners. Returns a teardown (used by tests). */
export function installNativeFeel(options: NativeFeelOptions): () => void {
	const cleanups: Array<() => void> = [];
	// One lazy load of the window bridge, shared by every listener below.
	const bridge = import('@owlat/desktop/src/window');

	if (!options.keepContextMenu) {
		const onContextMenu = (event: MouseEvent) => {
			if (event.defaultPrevented) return;
			const selected = window.getSelection()?.toString() ?? '';
			if (keepsDefaultContextMenu(event.target, selected, window.location.origin)) return;
			event.preventDefault();
		};
		document.addEventListener('contextmenu', onContextMenu);
		cleanups.push(() => document.removeEventListener('contextmenu', onContextMenu));
	}

	if (options.isMac) {
		// Tauri's drag script listens on `document` in the bubble phase; a
		// capturing listener on `document` runs first, so stopping the event
		// there keeps the stock maximize toggle from also firing. Like the stock
		// script, a double click that moved between press and release was a
		// drag, not a click.
		let pressX = 0;
		let pressY = 0;
		const onMouseDown = (event: MouseEvent) => {
			if (!isDragRegionDoubleClick(event)) return;
			pressX = event.clientX;
			pressY = event.clientY;
		};
		const onMouseUp = (event: MouseEvent) => {
			if (!isDragRegionDoubleClick(event)) return;
			if (event.clientX !== pressX || event.clientY !== pressY) return;
			event.stopImmediatePropagation();
			void bridge.then(({ titlebarDoubleClick }) => titlebarDoubleClick()).catch(() => {});
		};
		document.addEventListener('mousedown', onMouseDown, true);
		document.addEventListener('mouseup', onMouseUp, true);
		cleanups.push(() => {
			document.removeEventListener('mousedown', onMouseDown, true);
			document.removeEventListener('mouseup', onMouseUp, true);
		});
	}

	const root = document.documentElement;
	let disposed = false;
	void bridge
		.then(async ({ readZoomLevel, onZoomChanged }) => {
			applyNativeZoom(root, await readZoomLevel());
			const unlisten = await onZoomChanged((factor) => applyNativeZoom(root, factor));
			if (disposed) unlisten();
			else cleanups.push(unlisten);
		})
		.catch(() => {});

	return () => {
		disposed = true;
		for (const cleanup of cleanups.splice(0)) cleanup();
	};
}
