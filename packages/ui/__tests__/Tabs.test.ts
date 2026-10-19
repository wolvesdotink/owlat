// @vitest-environment happy-dom
/**
 * UiTabs draws the tabs; the caller renders the panel. The contract between the
 * two (utils/tabs.ts) must never leave an `aria-controls` pointing at a missing
 * element, and the selected-tab fallback has to be the same for the markup and
 * the arrow keys, so exactly one tab is tabbable whatever `modelValue` is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, useId, type Component } from 'vue';
import Tabs from '../components/ui/Tabs.vue';
import { tabPanelAttrs } from '../utils/tabs';

const TABS = [
	{ value: 'profile', label: 'Profile' },
	{ value: 'timeline', label: 'Timeline', count: 3 },
	{ value: 'files', label: 'Files' },
];

const mounted: VueWrapper[] = [];

afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
	document.body.innerHTML = '';
});

/** UiTabs alone, wired as `v-model` so the selection follows each emit. */
function mountTabs(props: Record<string, unknown> = {}): VueWrapper {
	const wrapper: VueWrapper = mount(Tabs as Component, {
		props: {
			tabs: TABS,
			'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }),
			...props,
		},
		attachTo: document.body,
	});
	mounted.push(wrapper);
	return wrapper;
}

/** How a consumer uses the contract: one panel id, shared by strip and region. */
function mountWithPanel(initial?: string): VueWrapper {
	const Consumer = defineComponent({
		setup() {
			const active = ref<string | undefined>(initial);
			const panelId = useId();
			return () => [
				h(Tabs as Component, {
					tabs: TABS,
					modelValue: active.value,
					panelId,
					'onUpdate:modelValue': (value: string) => (active.value = value),
				}),
				h('div', tabPanelAttrs(panelId, TABS, active.value), `content of ${active.value}`),
			];
		},
	});
	const wrapper = mount(Consumer, { attachTo: document.body });
	mounted.push(wrapper);
	return wrapper;
}

const tabButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tabbable = () => tabButtons().filter((tab) => tab.getAttribute('tabindex') === '0');

/** Every IDREF in an aria-controls / aria-labelledby resolves to an element. */
function danglingRefs(): string[] {
	const missing: string[] = [];
	for (const el of document.querySelectorAll('[aria-controls], [aria-labelledby]')) {
		for (const attr of ['aria-controls', 'aria-labelledby']) {
			for (const id of el.getAttribute(attr)?.split(/\s+/).filter(Boolean) ?? []) {
				if (!document.getElementById(id)) missing.push(`${attr}=${id}`);
			}
		}
	}
	return missing;
}

describe('UiTabs selection fallback', () => {
	it('selects the first tab when modelValue is omitted: exactly one tab is tabbable', () => {
		mountTabs();
		expect(tabbable()).toHaveLength(1);
		expect(tabbable()[0]!.textContent).toContain('Profile');
		expect(tabButtons().map((tab) => tab.getAttribute('aria-selected'))).toEqual([
			'true',
			'false',
			'false',
		]);
	});

	it('treats a modelValue that names no tab like an omitted one', () => {
		mountTabs({ modelValue: 'gone' });
		expect(tabbable()).toHaveLength(1);
		expect(tabbable()[0]!.textContent).toContain('Profile');
	});

	it('moves on from the fallback tab, not from nowhere', async () => {
		const wrapper = mountTabs();
		tabButtons()[0]!.focus();
		await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
		expect(wrapper.emitted('update:modelValue')).toEqual([['timeline']]);
		expect(document.activeElement).toBe(tabButtons()[1]);
		expect(tabbable()).toEqual([tabButtons()[1]]);
	});
});

describe('UiTabs roving focus', () => {
	it.each([
		['ArrowRight', 'files', 'profile'],
		['ArrowDown', 'files', 'profile'],
		['ArrowLeft', 'profile', 'files'],
		['ArrowUp', 'profile', 'files'],
		['Home', 'files', 'profile'],
		['End', 'profile', 'files'],
	])('%s from %s selects and focuses %s', async (key, from, to) => {
		const wrapper = mountTabs({ modelValue: from });
		await wrapper.get('[role="tablist"]').trigger('keydown', { key });
		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([to]);
		const target = tabButtons().find((tab) => tab.getAttribute('aria-selected') === 'true');
		expect(target?.textContent).toContain(TABS.find((tab) => tab.value === to)!.label);
		expect(document.activeElement).toBe(target);
		expect(tabbable()).toEqual([target]);
	});

	it('leaves other keys alone', async () => {
		const wrapper = mountTabs({ modelValue: 'timeline' });
		await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'a' });
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});
});

describe('UiTabs ↔ panel contract', () => {
	it('claims no panel when the caller passes no panel id', () => {
		mountTabs({ modelValue: 'timeline' });
		expect(tabButtons().some((tab) => tab.hasAttribute('aria-controls'))).toBe(false);
		expect(danglingRefs()).toEqual([]);
	});

	it('gives each instance its own tab ids', () => {
		// Two strips in one app: useId is unique per app, not across mounts.
		const Pair = defineComponent({
			setup: () => () => [
				h(Tabs as Component, { tabs: TABS }),
				h(Tabs as Component, { tabs: TABS }),
			],
		});
		mounted.push(mount(Pair, { attachTo: document.body }));
		const ids = tabButtons().map((tab) => tab.id);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
	});

	it('points every tab at the one rendered panel, which names the selected tab', async () => {
		const wrapper = mountWithPanel('timeline');
		const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
		// Activating any tab swaps this panel's content, so every tab controls it.
		expect(tabButtons().map((tab) => tab.getAttribute('aria-controls'))).toEqual([
			panel.id,
			panel.id,
			panel.id,
		]);
		expect(panel.getAttribute('aria-labelledby')).toBe(tabButtons()[1]!.id);
		expect(danglingRefs()).toEqual([]);

		await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'End' });
		expect(panel.getAttribute('aria-labelledby')).toBe(tabButtons()[2]!.id);
		expect(panel.textContent).toBe('content of files');
		expect(tabButtons().every((tab) => tab.getAttribute('aria-controls') === panel.id)).toBe(true);
		expect(danglingRefs()).toEqual([]);
	});

	it('makes the panel the next tab stop after the strip, even for static content', () => {
		mountWithPanel('profile');
		const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
		expect(panel.getAttribute('tabindex')).toBe('0');
		// Sequential focus order in DOM order: the selected tab, then the panel.
		const stops = [...document.querySelectorAll<HTMLElement>('button, [tabindex]')].filter(
			(el) => el.getAttribute('tabindex') !== '-1'
		);
		expect(stops).toEqual([tabButtons()[0], panel]);
		panel.focus();
		expect(document.activeElement).toBe(panel);
	});

	it('labels the panel by the fallback tab when the caller has no value yet', () => {
		mountWithPanel(undefined);
		const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
		expect(panel.getAttribute('aria-labelledby')).toBe(tabButtons()[0]!.id);
		expect(tabButtons().every((tab) => tab.getAttribute('aria-controls') === panel.id)).toBe(true);
		expect(tabbable()).toHaveLength(1);
		expect(danglingRefs()).toEqual([]);
	});
});
