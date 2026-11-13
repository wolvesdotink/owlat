/**
 * A 90-day bar chart is one tab stop, not 90: the bars use a roving tabindex
 * and the arrow keys move between them.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { mountUi, type MountedUi } from './i18n';
import UiBars from '../components/ui/Bars.vue';

let mounted: MountedUi | null = null;

afterEach(() => {
	mounted?.unmount();
	mounted = null;
});

const data = [
	{ label: 'Mon', value: 3 },
	{ label: 'Tue', value: 5 },
	{ label: 'Wed', value: 2 },
];

function bars(): HTMLElement[] {
	return Array.from(mounted!.el.querySelectorAll<HTMLElement>('[role="img"]'));
}

describe('UiBars keyboard', () => {
	it('keeps a single tab stop and moves it with the arrow keys', async () => {
		mounted = mountUi(UiBars, { data });
		expect(bars().map((bar) => bar.tabIndex)).toEqual([0, -1, -1]);

		bars()[0]!.focus();
		bars()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await nextTick();

		expect(document.activeElement).toBe(bars()[1]);
		expect(bars().map((bar) => bar.tabIndex)).toEqual([-1, 0, -1]);

		bars()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await nextTick();
		expect(document.activeElement).toBe(bars()[2]);
	});
});
