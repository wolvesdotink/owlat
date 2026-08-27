// @vitest-environment happy-dom
/**
 * The sliding highlight has to land ON the selected segment and nowhere else.
 *
 * The track is `grid-template-columns: repeat(N, 1fr)`, and `1fr` is
 * `minmax(auto, 1fr)`: a label wider than its equal share pushes the columns out
 * of even thirds. The old indicator was sized analytically at `100 / N`, so with
 * "Flat / Conversations / Categories" it overhung the short first segment and
 * painted over the neighbouring label. These assertions pin the indicator to the
 * MEASURED geometry of the selected button, which is the only thing that stays
 * true for unequal labels — i.e. for every locale.
 *
 * happy-dom has no layout engine, so the suite installs a tiny fake one:
 * `offsetWidth` comes from a per-label table and `offsetLeft` is the running sum
 * of the preceding siblings, exactly as a real flow would place them.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import SegmentedControl from '../components/ui/SegmentedControl.vue';

/** Deliberately uneven, like the real Flat / Conversations / Categories row. */
const LABEL_WIDTH: Record<string, number> = { Flat: 44, Conversations: 108, Categories: 84 };
/** `.segmented-control` padding — the first column starts here. */
const TRACK_PADDING = 3;

const OPTIONS = [
	{ value: 'flat', label: 'Flat' },
	{ value: 'conversations', label: 'Conversations' },
	{ value: 'categories', label: 'Categories' },
];

const widthOf = (el: Element) => LABEL_WIDTH[el.textContent?.trim() ?? ''] ?? 0;

let originalWidth: PropertyDescriptor | undefined;
let originalLeft: PropertyDescriptor | undefined;

beforeEach(() => {
	originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
	originalLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft');
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get(this: HTMLElement) {
			return widthOf(this);
		},
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
		configurable: true,
		get(this: HTMLElement) {
			let x = TRACK_PADDING;
			for (const sibling of this.parentElement?.children ?? []) {
				if (sibling === this) return x;
				if (sibling.tagName === 'BUTTON') x += widthOf(sibling);
			}
			return x;
		},
	});
});

afterEach(() => {
	if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
	else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
	if (originalLeft) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', originalLeft);
	else Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft');
});

function mountControl(modelValue: string) {
	return mount(SegmentedControl, {
		props: { options: OPTIONS, modelValue, size: 'sm' as const },
		attachTo: document.body,
	});
}

/** `left: 47px; width: 108px` → `{ left: 47, width: 108 }`. */
function indicatorBox(style: string): { left: number; width: number } {
	const px = (property: string) =>
		Number(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)px`).exec(style)?.[1] ?? NaN);
	return { left: px('left'), width: px('width') };
}

async function settle() {
	await nextTick();
	await nextTick();
}

describe('SegmentedControl sliding indicator', () => {
	it('matches the selected segment exactly, not an even 1/N slice', async () => {
		const w = mountControl('flat');
		await settle();
		expect(indicatorBox(w.find('.segmented-control__indicator').attributes('style') ?? '')).toEqual(
			{ left: TRACK_PADDING, width: LABEL_WIDTH.Flat }
		);
		w.unmount();
	});

	it('follows the selection onto a wider segment', async () => {
		const w = mountControl('conversations');
		await settle();
		expect(indicatorBox(w.find('.segmented-control__indicator').attributes('style') ?? '')).toEqual(
			{ left: TRACK_PADDING + LABEL_WIDTH.Flat!, width: LABEL_WIDTH.Conversations }
		);
		w.unmount();
	});

	it('re-measures when the selection changes', async () => {
		const w = mountControl('flat');
		await settle();
		await w.setProps({ modelValue: 'categories' });
		await settle();
		expect(indicatorBox(w.find('.segmented-control__indicator').attributes('style') ?? '')).toEqual(
			{
				left: TRACK_PADDING + LABEL_WIDTH.Flat! + LABEL_WIDTH.Conversations!,
				width: LABEL_WIDTH.Categories,
			}
		);
		w.unmount();
	});

	it('never spills over the next segment for any selection', async () => {
		for (const option of OPTIONS) {
			const w = mountControl(option.value);
			await settle();
			const box = indicatorBox(w.find('.segmented-control__indicator').attributes('style') ?? '');
			const buttons = w.findAll('.segmented-control__btn');
			const index = OPTIONS.indexOf(option);
			const next = buttons[index + 1]?.element as HTMLElement | undefined;
			expect(box.left).toBeGreaterThanOrEqual(TRACK_PADDING);
			if (next) expect(box.left + box.width).toBeLessThanOrEqual(next.offsetLeft);
			w.unmount();
		}
	});

	it('falls back to even columns while the control has no layout yet', () => {
		// No fake layout for this element (offsetWidth 0) — the analytical
		// fallback must still paint an indicator rather than collapse to 0px.
		const w = mount(SegmentedControl, {
			props: { options: [{ value: 'a', label: 'Unmeasured' }], modelValue: 'a' },
		});
		const style = w.find('.segmented-control__indicator').attributes('style') ?? '';
		expect(style).toContain('calc(100% - 3px)');
		w.unmount();
	});
});
