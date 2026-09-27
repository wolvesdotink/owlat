import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	NATIVE_ZOOM_VAR,
	applyNativeZoom,
	installNativeFeel,
	isDragRegionDoubleClick,
	keepsDefaultContextMenu,
} from '../nativeFeel.client';

const { titlebarDoubleClickMock, readZoomLevelMock, onZoomChangedMock } = vi.hoisted(() => ({
	titlebarDoubleClickMock: vi.fn().mockResolvedValue(undefined),
	readZoomLevelMock: vi.fn().mockResolvedValue(1.25),
	onZoomChangedMock: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@owlat/desktop/src/window', () => ({
	titlebarDoubleClick: titlebarDoubleClickMock,
	readZoomLevel: readZoomLevelMock,
	onZoomChanged: onZoomChangedMock,
}));

const ORIGIN = 'tauri://localhost';

function el(html: string): Element {
	const host = document.createElement('div');
	host.innerHTML = html;
	document.body.appendChild(host);
	return host.querySelector('[data-t]') ?? host.firstElementChild!;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('keepsDefaultContextMenu', () => {
	it('suppresses the browser menu on plain app chrome', () => {
		expect(keepsDefaultContextMenu(el('<nav><span data-t>Inbox</span></nav>'), '', ORIGIN)).toBe(
			false
		);
		expect(keepsDefaultContextMenu(el('<button data-t>Archive</button>'), '', ORIGIN)).toBe(false);
		expect(keepsDefaultContextMenu(null, '', ORIGIN)).toBe(false);
	});

	it('keeps it in text fields and rich-text editors', () => {
		expect(keepsDefaultContextMenu(el('<input data-t>'), '', ORIGIN)).toBe(true);
		expect(keepsDefaultContextMenu(el('<textarea data-t></textarea>'), '', ORIGIN)).toBe(true);
		expect(
			keepsDefaultContextMenu(el('<div data-t contenteditable="true">Hi</div>'), '', ORIGIN)
		).toBe(true);
	});

	it('keeps it whenever text is selected, so Copy is one right-click away', () => {
		expect(keepsDefaultContextMenu(el('<span data-t>Subject</span>'), 'Subject', ORIGIN)).toBe(
			true
		);
		expect(keepsDefaultContextMenu(el('<span data-t>Subject</span>'), '   ', ORIGIN)).toBe(false);
	});

	it('keeps it on external and mailto links, not on in-app ones', () => {
		expect(
			keepsDefaultContextMenu(
				el('<a href="https://owlat.app/docs"><b data-t>Docs</b></a>'),
				'',
				ORIGIN
			)
		).toBe(true);
		expect(
			keepsDefaultContextMenu(el('<a data-t href="mailto:ada@example.com">Ada</a>'), '', ORIGIN)
		).toBe(true);
		expect(
			keepsDefaultContextMenu(el('<a data-t href="/dashboard/inbox">Inbox</a>'), '', ORIGIN)
		).toBe(false);
	});
});

describe('isDragRegionDoubleClick', () => {
	function click(target: Element, init: MouseEventInit): MouseEvent {
		const event = new MouseEvent('mouseup', { bubbles: true, ...init });
		Object.defineProperty(event, 'target', { value: target });
		return event;
	}

	it('matches a primary double-click on the drag region itself', () => {
		const bar = el('<div data-t data-tauri-drag-region></div>');
		expect(isDragRegionDoubleClick(click(bar, { button: 0, detail: 2 }))).toBe(true);
	});

	it('ignores single clicks, other buttons, opted-out and non-region targets', () => {
		const bar = el('<div data-t data-tauri-drag-region></div>');
		expect(isDragRegionDoubleClick(click(bar, { button: 0, detail: 1 }))).toBe(false);
		expect(isDragRegionDoubleClick(click(bar, { button: 2, detail: 2 }))).toBe(false);
		const off = el('<div data-t data-tauri-drag-region="false"></div>');
		expect(isDragRegionDoubleClick(click(off, { button: 0, detail: 2 }))).toBe(false);
		const button = el('<div data-tauri-drag-region><button data-t>Go</button></div>');
		expect(isDragRegionDoubleClick(click(button, { button: 0, detail: 2 }))).toBe(false);
	});
});

describe('applyNativeZoom', () => {
	it('writes the factor, falling back to 1 for nonsense', () => {
		const root = document.createElement('html');
		applyNativeZoom(root, 1.5);
		expect(root.style.getPropertyValue(NATIVE_ZOOM_VAR)).toBe('1.5');
		applyNativeZoom(root, 0);
		expect(root.style.getPropertyValue(NATIVE_ZOOM_VAR)).toBe('1');
	});
});

describe('installNativeFeel', () => {
	let teardown: (() => void) | null = null;

	beforeEach(() => {
		titlebarDoubleClickMock.mockClear();
	});

	afterEach(() => {
		teardown?.();
		teardown = null;
		document.documentElement.style.removeProperty(NATIVE_ZOOM_VAR);
	});

	it('cancels the browser context menu on chrome but keeps it in text fields', () => {
		teardown = installNativeFeel({ isMac: false, keepContextMenu: false });
		const chrome = el('<button data-t>Archive</button>');
		const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		chrome.dispatchEvent(plain);
		expect(plain.defaultPrevented).toBe(true);

		const input = el('<input data-t>');
		const inField = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		input.dispatchEvent(inField);
		expect(inField.defaultPrevented).toBe(false);
	});

	it('leaves the context menu alone when asked to (dev builds)', () => {
		teardown = installNativeFeel({ isMac: false, keepContextMenu: true });
		const chrome = el('<button data-t>Archive</button>');
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		chrome.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('routes a macOS title-bar double-click to the native setting and stops the stock toggle', async () => {
		teardown = installNativeFeel({ isMac: true, keepContextMenu: false });
		const stock = vi.fn();
		document.addEventListener('mouseup', stock);
		const bar = el('<div data-t data-tauri-drag-region></div>');
		bar.dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true, detail: 2, clientX: 5, clientY: 5 })
		);
		bar.dispatchEvent(
			new MouseEvent('mouseup', { bubbles: true, detail: 2, clientX: 5, clientY: 5 })
		);
		await vi.waitFor(() => expect(titlebarDoubleClickMock).toHaveBeenCalledTimes(1));
		expect(stock).not.toHaveBeenCalled();
		document.removeEventListener('mouseup', stock);
	});

	it('does not claim title-bar double-clicks off macOS', async () => {
		teardown = installNativeFeel({ isMac: false, keepContextMenu: false });
		const bar = el('<div data-t data-tauri-drag-region></div>');
		bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 2 }));
		bar.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, detail: 2 }));
		await new Promise((r) => setTimeout(r, 0));
		expect(titlebarDoubleClickMock).not.toHaveBeenCalled();
	});

	it('mirrors the current zoom onto <html>', async () => {
		teardown = installNativeFeel({ isMac: false, keepContextMenu: false });
		await vi.waitFor(() =>
			expect(document.documentElement.style.getPropertyValue(NATIVE_ZOOM_VAR)).toBe('1.25')
		);
		expect(onZoomChangedMock).toHaveBeenCalled();
	});
});
