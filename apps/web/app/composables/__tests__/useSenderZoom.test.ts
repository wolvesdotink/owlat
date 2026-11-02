/**
 * The per-sender zoom owner: one shared value read from this device's storage,
 * written back on change, followed across tabs, and multiplied into the
 * typography a body from that sender renders with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { resetSenderZoomForTests, useSenderMailTypography, useSenderZoom } from '../useSenderZoom';
import { resetReadingComfortForTests, useReadingComfort } from '../useReadingComfort';
import { SENDER_ZOOM_STORAGE_KEY } from '~/utils/senderZoom';

const stored = () => {
	const raw = localStorage.getItem(SENDER_ZOOM_STORAGE_KEY);
	return raw === null ? null : (JSON.parse(raw) as Record<string, number>);
};

beforeEach(() => {
	localStorage.clear();
	resetSenderZoomForTests();
	resetReadingComfortForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSenderZoomForTests();
	resetReadingComfortForTests();
});

describe('useSenderZoom', () => {
	it('keys the zoom by sender address, whatever shape the From header has', () => {
		const { applyZoom, zoomOf } = useSenderZoom();
		expect(applyZoom('News <News@Example.com>', 'zoomIn')).toBe(true);
		expect(zoomOf('news@example.com')).toBe(110);
		expect(zoomOf('other@example.com')).toBe(100);
		expect(stored()).toEqual({ 'news@example.com': 110 });
	});

	it('does nothing for a From header without an address', () => {
		const { applyZoom, count } = useSenderZoom();
		expect(applyZoom('Undisclosed', 'zoomIn')).toBe(false);
		expect(applyZoom(undefined, 'zoomIn')).toBe(false);
		expect(count.value).toBe(0);
		expect(stored()).toBeNull();
	});

	it('forgets a sender reset to 100%, and clears every sender at once', () => {
		const { applyZoom, clearAll, count } = useSenderZoom();
		applyZoom('a@example.com', 'zoomIn');
		applyZoom('b@example.com', 'zoomOut');
		expect(count.value).toBe(2);
		applyZoom('a@example.com', 'zoomReset');
		expect(stored()).toEqual({ 'b@example.com': 90 });
		clearAll();
		expect(count.value).toBe(0);
		expect(stored()).toBeNull();
	});

	it('reads what this device stored, and follows another tab', async () => {
		localStorage.setItem(SENDER_ZOOM_STORAGE_KEY, JSON.stringify({ 'a@example.com': 150 }));
		const { zoomOf } = useSenderZoom();
		expect(zoomOf('a@example.com')).toBe(150);

		window.dispatchEvent(
			new StorageEvent('storage', {
				key: SENDER_ZOOM_STORAGE_KEY,
				newValue: JSON.stringify({ 'a@example.com': 200 }),
			})
		);
		await nextTick();
		expect(zoomOf('a@example.com')).toBe(200);
		window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
		expect(zoomOf('a@example.com')).toBe(100);
	});

	it('still applies a change when storage refuses to save it', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('quota', 'QuotaExceededError');
		});
		const { applyZoom, zoomOf } = useSenderZoom();
		expect(() => applyZoom('a@example.com', 'zoomIn')).not.toThrow();
		expect(zoomOf('a@example.com')).toBe(110);
	});
});

describe('useSenderMailTypography', () => {
	it('multiplies the sender zoom into the app text size, per sender', () => {
		useReadingComfort().set('uiTextSize', 120);
		useSenderZoom().applyZoom('a@example.com', 'zoomIn');
		const zoomed = useSenderMailTypography(() => 'a@example.com');
		const other = useSenderMailTypography(() => 'b@example.com');
		expect(zoomed.value).toEqual({ textSize: 'default', readingWidth: 'default', zoom: 1.32 });
		expect(other.value.zoom).toBe(1.2);

		useSenderZoom().applyZoom('a@example.com', 'zoomReset');
		expect(zoomed.value.zoom).toBe(1.2);
	});
});
