import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref, useId, type Ref } from 'vue';
import NavigationPortal from '../NavigationPortal.vue';
import { useSectionNavigation } from '~/composables/useSectionNavigation';

const desktop = ref(true);
const state = new Map<string, Ref>();
const wrappers: ReturnType<typeof mount>[] = [];
/** The shell's navigation target and the page's `main`, appended per test. */
const fixture: HTMLElement[] = [];

beforeEach(() => {
	desktop.value = true;
	state.clear();
	const target = document.createElement('div');
	target.id = 'section-navigation';
	const main = document.createElement('main');
	document.body.append(target, main);
	fixture.push(target, main);
	vi.stubGlobal('useId', useId);
	vi.stubGlobal('useMediaQuery', () => desktop);
	vi.stubGlobal('useSectionNavigation', useSectionNavigation);
	vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(initial()));
		return state.get(key);
	});
});

afterEach(() => {
	wrappers.forEach((wrapper) => wrapper.unmount());
	wrappers.length = 0;
	for (const node of fixture.splice(0)) node.remove();
});

function mountPortal(title = 'Mail') {
	const wrapper = mount(NavigationPortal, {
		props: { title },
		attachTo: document.querySelector('main')!,
		global: {
			provide: { 'section-navigation-target': ref(document.querySelector('#section-navigation')) },
		},
		slots: { default: '<nav><button>Inbox</button></nav>' },
	});
	wrappers.push(wrapper);
	return wrapper;
}

describe('section navigation portal', () => {
	it('moves one existing navigation tree into the shell and restores it on mobile', async () => {
		mountPortal();
		await nextTick();
		const button = document.querySelector('#section-navigation button');
		expect(button?.textContent).toBe('Inbox');
		expect(document.querySelectorAll('button')).toHaveLength(1);
		expect(useSectionNavigation().activeSection.value?.title).toBe('Mail');

		desktop.value = false;
		await nextTick();
		expect(document.querySelector('main button')).toBe(button);
		expect(document.querySelector('#section-navigation button')).toBeNull();
		expect(useSectionNavigation().activeSection.value).toBeNull();
	});

	it('keeps the original drawer on mobile and registers when resized to desktop', async () => {
		desktop.value = false;
		mountPortal();
		await nextTick();
		expect(document.querySelector('main button')).not.toBeNull();
		expect(useSectionNavigation().activeSection.value).toBeNull();
		desktop.value = true;
		await nextTick();
		expect(document.querySelector('#section-navigation button')).not.toBeNull();
	});

	it('does not clear the next section when an outgoing page unmounts', () => {
		const navigation = useSectionNavigation();
		navigation.register('old', 'Mail');
		navigation.showAppNavigation.value = true;
		navigation.register('new', 'Preferences');
		navigation.unregister('old');
		expect(navigation.activeSection.value?.title).toBe('Preferences');
		expect(navigation.showAppNavigation.value).toBe(false);
		navigation.unregister('new');
		expect(navigation.activeSection.value).toBeNull();
	});
});
