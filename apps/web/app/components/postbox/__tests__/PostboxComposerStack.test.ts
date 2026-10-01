// @vitest-environment happy-dom
/**
 * The popup stack on a phone: one composer floats (as a full-width sheet), the
 * rest dock, and the dock's chips stay out from under the sheet, where they
 * would cover its Send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxComposerStack from '../PostboxComposerStack.vue';

const PopupStub = defineComponent({
	name: 'PostboxComposerPopup',
	props: { composer: { type: Object, required: true }, slotIndex: Number },
	setup: (props) => () =>
		h('div', { 'data-testid': 'popup', 'data-id': (props.composer as { id: string }).id }),
});
const DockStub = defineComponent({
	name: 'PostboxComposerDock',
	props: { composers: { type: Array, required: true } },
	setup: (props) => () =>
		h('div', { 'data-testid': 'dock', 'data-count': String(props.composers.length) }),
});

const state = ref<{ id: string; minimized: boolean }[]>([]);
const realMatchMedia = window.matchMedia;

function setPhone(phone: boolean) {
	window.matchMedia = ((query: string) => ({
		matches: phone && query.includes('max-width'),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
	vi.stubGlobal('usePostboxComposerStack', () => ({ state }));
});
afterEach(() => {
	window.matchMedia = realMatchMedia;
});

function mountStack() {
	return mount(PostboxComposerStack, {
		global: {
			components: {
				PostboxComposerPopup: PopupStub,
				PostboxComposerDock: DockStub,
				PostboxUndoSendToast: defineComponent({ render: () => null }),
			},
			stubs: { teleport: true },
		},
	});
}

const popupIds = (w: ReturnType<typeof mountStack>) =>
	w.findAll('[data-testid="popup"]').map((p) => p.attributes('data-id'));
const dockCount = (w: ReturnType<typeof mountStack>) =>
	w.get('[data-testid="dock"]').attributes('data-count');

describe('PostboxComposerStack', () => {
	it('floats two composers side by side on a wide screen', () => {
		setPhone(false);
		state.value = [
			{ id: 'a', minimized: false },
			{ id: 'b', minimized: false },
		];
		const w = mountStack();
		expect(popupIds(w)).toEqual(['a', 'b']);
		expect(dockCount(w)).toBe('0');
	});

	it('floats only the newest on a phone and keeps the dock off its sheet', () => {
		setPhone(true);
		state.value = [
			{ id: 'a', minimized: false },
			{ id: 'b', minimized: false },
		];
		const w = mountStack();
		expect(popupIds(w)).toEqual(['b']);
		expect(dockCount(w)).toBe('0');
	});

	it('shows the dock on a phone once nothing floats', () => {
		setPhone(true);
		state.value = [
			{ id: 'a', minimized: true },
			{ id: 'b', minimized: true },
		];
		const w = mountStack();
		expect(popupIds(w)).toEqual([]);
		expect(dockCount(w)).toBe('2');
	});
});
