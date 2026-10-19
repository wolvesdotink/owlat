// @vitest-environment happy-dom
/**
 * Arrow/Home/End roving in UiSegmentedControl skips disabled segments: it never
 * focuses or selects one, wraps past them, and does nothing when no segment is
 * enabled. Selection still follows focus, and exactly one enabled segment is
 * tabbable whatever the model holds.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SegmentedControl from '../components/ui/SegmentedControl.vue';

interface Option {
	value: string;
	label: string;
	disabled?: boolean;
}

const ABC: Option[] = [
	{ value: 'a', label: 'A' },
	{ value: 'b', label: 'B', disabled: true },
	{ value: 'c', label: 'C' },
];

const EDGES: Option[] = [
	{ value: 'a', label: 'A', disabled: true },
	{ value: 'b', label: 'B' },
	{ value: 'c', label: 'C' },
	{ value: 'd', label: 'D', disabled: true },
];

function mountControl(options: Option[], modelValue?: string) {
	// Act as a v-model so a key press that selects moves the model too. The
	// handler only runs after mount, by which time `w` is assigned.
	let w: ReturnType<typeof mount> | undefined;
	w = mount(SegmentedControl, {
		props: {
			options,
			modelValue,
			'onUpdate:modelValue': (value: string) => void w?.setProps({ modelValue: value }),
		},
		attachTo: document.body,
	});
	return w;
}

async function press(w: ReturnType<typeof mount>, key: string) {
	const target = document.activeElement ?? w.element;
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	await w.vm.$nextTick();
}

const emitted = (w: ReturnType<typeof mount>) =>
	(w.emitted('update:modelValue') ?? []).map(([value]) => value);
const focusedLabel = () => document.activeElement?.textContent?.trim();
const tabStops = (w: ReturnType<typeof mount>) =>
	w
		.findAll('button')
		.filter((b) => b.attributes('tabindex') === '0')
		.map((b) => b.text());

describe('SegmentedControl keyboard roving', () => {
	it('ArrowRight from A skips disabled B to C, then wraps back to A', async () => {
		const w = mountControl(ABC, 'a');
		(w.findAll('button')[0]!.element as HTMLButtonElement).focus();
		await press(w, 'ArrowRight');
		expect(focusedLabel()).toBe('C');
		await press(w, 'ArrowRight');
		expect(focusedLabel()).toBe('A');
		expect(emitted(w)).toEqual(['c', 'a']);
		w.unmount();
	});

	it('ArrowLeft from C skips disabled B to A, then wraps back to C', async () => {
		const w = mountControl(ABC, 'c');
		(w.findAll('button')[2]!.element as HTMLButtonElement).focus();
		await press(w, 'ArrowLeft');
		expect(focusedLabel()).toBe('A');
		await press(w, 'ArrowLeft');
		expect(focusedLabel()).toBe('C');
		expect(emitted(w)).toEqual(['a', 'c']);
		w.unmount();
	});

	it('Home and End land on the first and last enabled segments', async () => {
		const w = mountControl(EDGES, 'b');
		(w.findAll('button')[1]!.element as HTMLButtonElement).focus();
		await press(w, 'End');
		expect(focusedLabel()).toBe('C');
		await press(w, 'Home');
		expect(focusedLabel()).toBe('B');
		expect(emitted(w)).toEqual(['c', 'b']);
		w.unmount();
	});

	it('never selects a disabled segment', async () => {
		const w = mountControl(EDGES, 'b');
		(w.findAll('button')[1]!.element as HTMLButtonElement).focus();
		for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'End', 'Home']) {
			await press(w, key);
		}
		expect(emitted(w).every((value) => value === 'b' || value === 'c')).toBe(true);
		w.unmount();
	});

	it('is a no-op when every segment is disabled, and when there are none', async () => {
		const allDisabled = ABC.map((option) => ({ ...option, disabled: true }));
		for (const options of [allDisabled, []]) {
			const w = mountControl(options, 'a');
			for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
				w.element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
			}
			expect(w.emitted('update:modelValue')).toBeUndefined();
			expect(tabStops(w)).toEqual([]);
			w.unmount();
		}
	});

	it('keeps exactly one enabled tab stop when the selection is missing or disabled', () => {
		// The fallback tab stop is focusable, not selected: aria state still
		// follows the model (a disabled selection stays the selected segment).
		for (const [modelValue, selected] of [
			[undefined, []],
			['gone', []],
			['a', ['A']],
		] as const) {
			const w = mountControl(EDGES, modelValue);
			expect(tabStops(w)).toEqual(['B']);
			expect(w.findAll('[aria-selected="true"]').map((b) => b.text())).toEqual(selected);
			w.unmount();
		}
		const selected = mountControl(EDGES, 'c');
		expect(tabStops(selected)).toEqual(['C']);
		selected.unmount();
	});

	it('moves from the focused segment when the tab stop is a fallback', async () => {
		// No model: Tab lands on B (first enabled), ArrowRight goes on to C.
		const w = mountControl(EDGES);
		(w.findAll('button')[1]!.element as HTMLButtonElement).focus();
		await press(w, 'ArrowRight');
		expect(focusedLabel()).toBe('C');
		expect(emitted(w)).toEqual(['c']);
		w.unmount();
	});
});
