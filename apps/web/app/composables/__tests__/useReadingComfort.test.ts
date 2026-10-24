/**
 * The reading-comfort owner: one shared value read from this device's
 * storage, written back on change, followed across tabs, and put on <html>
 * (attributes for the CSS, the shared reduced-motion state for JavaScript).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { prefersReducedMotion, useReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import {
	applyReadingComfort,
	resetReadingComfortForTests,
	useReadingComfort,
} from '../useReadingComfort';
import {
	READING_COMFORT_DEFAULTS,
	READING_COMFORT_STORAGE_KEY,
	type ReadingComfort,
} from '~/utils/readingComfort';

const stored = (): ReadingComfort | null => {
	const raw = localStorage.getItem(READING_COMFORT_STORAGE_KEY);
	return raw === null ? null : (JSON.parse(raw) as ReadingComfort);
};

beforeEach(() => {
	localStorage.clear();
	resetReadingComfortForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetReadingComfortForTests();
	for (const name of ['data-contrast', 'data-motion', 'data-list-density']) {
		document.documentElement.removeAttribute(name);
	}
});

describe('useReadingComfort', () => {
	it('starts at the defaults on an untouched device and writes nothing', () => {
		const { comfort, isChanged } = useReadingComfort();
		expect(comfort.value).toEqual(READING_COMFORT_DEFAULTS);
		expect(isChanged('textSize')).toBe(false);
		expect(stored()).toBeNull();
	});

	it('reads what this device stored, dropping invalid fields', () => {
		localStorage.setItem(
			READING_COMFORT_STORAGE_KEY,
			JSON.stringify({ textSize: 'large', listDensity: 'cramped', highContrast: true })
		);
		const { comfort } = useReadingComfort();
		expect(comfort.value).toEqual({
			...READING_COMFORT_DEFAULTS,
			textSize: 'large',
			highContrast: true,
		});
	});

	it('persists a change, which a reload then reads back', () => {
		const first = useReadingComfort();
		first.set('readingWidth', 'wide');
		first.set('reduceMotion', true);
		expect(stored()).toEqual({
			...READING_COMFORT_DEFAULTS,
			readingWidth: 'wide',
			reduceMotion: true,
		});

		resetReadingComfortForTests();
		expect(useReadingComfort().comfort.value).toEqual({
			...READING_COMFORT_DEFAULTS,
			readingWidth: 'wide',
			reduceMotion: true,
		});
	});

	it('shares one value between every caller', () => {
		const a = useReadingComfort();
		const b = useReadingComfort();
		a.set('listDensity', 'compact');
		expect(b.comfort.value.listDensity).toBe('compact');
		expect(b.isChanged('listDensity')).toBe(true);
	});

	it('restores a setting to its default', () => {
		const { set, reset, comfort, isChanged } = useReadingComfort();
		set('textSize', 'larger');
		reset('textSize');
		expect(comfort.value.textSize).toBe('default');
		expect(isChanged('textSize')).toBe(false);
		expect(stored()?.textSize).toBe('default');
	});

	it('follows a change made in another tab', async () => {
		const { comfort, mailTypography } = useReadingComfort();
		const next = { ...READING_COMFORT_DEFAULTS, textSize: 'small', readingWidth: 'full' };
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: READING_COMFORT_STORAGE_KEY,
				newValue: JSON.stringify(next),
			})
		);
		await nextTick();
		expect(comfort.value).toEqual(next);
		expect(mailTypography.value).toEqual({ textSize: 'small', readingWidth: 'full' });

		// Another key changing is none of its business; a cleared storage is.
		window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '{}' }));
		expect(comfort.value).toEqual(next);
		window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
		expect(comfort.value).toEqual(READING_COMFORT_DEFAULTS);
	});

	it('still applies a change when storage refuses to save it', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('quota', 'QuotaExceededError');
		});
		const { set, comfort } = useReadingComfort();
		expect(() => set('highContrast', true)).not.toThrow();
		expect(comfort.value.highContrast).toBe(true);
	});

	it('falls back to the defaults when storage cannot be read', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new DOMException('denied', 'SecurityError');
		});
		expect(useReadingComfort().comfort.value).toEqual(READING_COMFORT_DEFAULTS);
	});
});

describe('applyReadingComfort', () => {
	it('sets the root attributes and removes them again for the defaults', () => {
		const root = document.documentElement;
		applyReadingComfort(root, {
			...READING_COMFORT_DEFAULTS,
			highContrast: true,
			reduceMotion: true,
			listDensity: 'compact',
		});
		expect(root.getAttribute('data-contrast')).toBe('more');
		expect(root.getAttribute('data-motion')).toBe('reduce');
		expect(root.getAttribute('data-list-density')).toBe('compact');

		applyReadingComfort(root, READING_COMFORT_DEFAULTS);
		expect(root.hasAttribute('data-contrast')).toBe(false);
		expect(root.hasAttribute('data-motion')).toBe(false);
		expect(root.hasAttribute('data-list-density')).toBe(false);
	});

	it('hands the motion switch to the shared reduced-motion owner', async () => {
		const scope = effectScope();
		const reactive = scope.run(() => useReducedMotion())!;
		expect(prefersReducedMotion()).toBe(false);

		applyReadingComfort(document.documentElement, {
			...READING_COMFORT_DEFAULTS,
			reduceMotion: true,
		});
		await nextTick();
		expect(prefersReducedMotion()).toBe(true);
		expect(reactive.value).toBe(true);

		applyReadingComfort(document.documentElement, READING_COMFORT_DEFAULTS);
		await nextTick();
		expect(prefersReducedMotion()).toBe(false);
		expect(reactive.value).toBe(false);
		scope.stop();
	});
});
