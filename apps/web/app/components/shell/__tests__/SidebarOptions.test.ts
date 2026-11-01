/**
 * "Sidebar options" against the real UiDropdownMenu. Tab closes a menu, so
 * every control in it has to be reachable with the arrows: the per-inbox
 * steppers as well as the sort items.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, inject, nextTick, provide, ref } from 'vue';
import UiDropdownMenu from '@owlat/ui/components/ui/DropdownMenu.vue';
import UiDropdownMenuItem from '@owlat/ui/components/ui/DropdownMenuItem.vue';
import UiDropdownDivider from '@owlat/ui/components/ui/DropdownDivider.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import SidebarOptions from '../SidebarOptions.vue';

const count = ref(3);
let sets = 0;

beforeAll(() => {
	vi.stubGlobal('provide', provide);
	vi.stubGlobal('inject', inject);
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useShellSidebarPrefs: () => ({
			// Clamped like the real setter.
			perInbox: computed({
				get: () => count.value,
				set: (value: number) => {
					sets += 1;
					count.value = Math.min(10, Math.max(0, value));
				},
			}),
			sort: ref('recent'),
		}),
	});
});

let wrapper: VueWrapper | null = null;
beforeEach(() => {
	count.value = 3;
	sets = 0;
	wrapper = mount(SidebarOptions, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiDropdownMenu, UiDropdownMenuItem, UiDropdownDivider },
		},
	});
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const focused = () => document.activeElement as HTMLElement | null;
const press = (key: string) =>
	focused()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const label = (el: HTMLElement | null) => el?.getAttribute('aria-label') ?? el?.textContent?.trim();

async function openMenu() {
	await wrapper!.get('button').trigger('click');
	await nextTick();
	await nextTick();
}

describe('SidebarOptions keyboard', () => {
	it('reaches the steppers and the sort items with the arrows', async () => {
		await openMenu();
		const visited = [label(focused())];
		for (let i = 0; i < 4; i++) {
			press('ArrowDown');
			visited.push(label(focused()));
		}
		expect(visited).toEqual([
			'Show fewer',
			'Show more',
			'Most recent first',
			'Most urgent first',
			'Show fewer',
		]);
		press('ArrowUp');
		expect(label(focused())).toBe('Most urgent first');
	});

	it('changes the count from the keyboard and keeps focus in the menu at a limit', async () => {
		count.value = 9;
		await openMenu();
		press('ArrowDown');
		const more = focused()!;
		expect(label(more)).toBe('Show more');
		more.click();
		await nextTick();
		expect(count.value).toBe(10);
		// At the limit the stepper is aria-disabled: still focused, skipped by the arrows.
		expect(more.getAttribute('aria-disabled')).toBe('true');
		expect(focused()).toBe(more);
		press('ArrowDown');
		expect(label(focused())).toBe('Most recent first');
		press('ArrowUp');
		expect(label(focused())).toBe('Show fewer');
		press('ArrowDown');
		expect(label(focused())).toBe('Most recent first');
	});

	it('does not touch the preference when a stepper at its limit is activated', async () => {
		const stepper = (name: string) =>
			document.querySelector<HTMLElement>(`[role="menu"] [aria-label="${name}"]`)!;
		for (const [start, name] of [
			[10, 'Show more'],
			[0, 'Show fewer'],
		] as const) {
			count.value = start;
			await openMenu();
			const button = stepper(name);
			expect(button.getAttribute('aria-disabled')).toBe('true');
			button.focus();
			// Enter and Space on a focused button activate it with a click.
			button.click();
			button.click();
			await nextTick();
			expect(count.value).toBe(start);
			expect(focused()).toBe(button);
			press('Escape');
			await nextTick();
		}
		expect(sets).toBe(0);
	});
});
