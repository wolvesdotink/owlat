/**
 * Which layer a real Escape press reaches.
 *
 * Playwright presses the key, so the event takes the browser's own route:
 * window capture first, then the focused element, then the bubble back up.
 * The page's own listeners (a focused field's handler, a window shortcut
 * listener) sit on that route, and the assertions are about which of them the
 * press still reaches.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, type Ref } from 'vue';
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';

interface LayerSpec {
	open: Ref<boolean>;
	/** Escape presses this layer's handler received. */
	presses: number;
	/** Return false from the handler: decline the press. */
	declines?: boolean;
	base?: boolean;
}

function layer(options: { declines?: boolean; base?: boolean } = {}): LayerSpec {
	return { open: ref(true), presses: 0, ...options };
}

/** Mounts one component per layer, in order, plus a text field that handles its own keys. */
function mountLayers(...specs: LayerSpec[]) {
	const fieldKeys: string[] = [];
	const Layer = defineComponent({
		props: { index: { type: Number, required: true } },
		setup(props) {
			const spec = specs[props.index]!;
			useEscapeLayer(
				spec.open,
				() => {
					spec.presses += 1;
					if (spec.declines) return false;
					spec.open.value = false;
				},
				{ base: spec.base }
			);
			return () => null;
		},
	});
	const Page = defineComponent({
		setup: () => () =>
			h('div', [
				h('input', {
					'data-testid': 'field',
					onKeydown: (event: KeyboardEvent) => fieldKeys.push(event.key),
				}),
				...specs.map((_, index) => h(Layer, { index })),
			]),
	});
	const wrapper = mount(Page, { attachTo: document.body });
	const field = wrapper.get<HTMLInputElement>('[data-testid="field"]').element;
	field.focus();
	return { wrapper, fieldKeys };
}

/** Escape presses that made it to the window's bubble phase, and whether a layer claimed them. */
function windowEscapes() {
	const seen: { prevented: boolean }[] = [];
	const listener = (event: KeyboardEvent) => {
		if (event.key === 'Escape') seen.push({ prevented: event.defaultPrevented });
	};
	window.addEventListener('keydown', listener);
	onTestFinished(() => window.removeEventListener('keydown', listener));
	return seen;
}

const escape = () => userEvent.keyboard('{Escape}');

describe('useEscapeLayer in a real browser', () => {
	it('gives each press to the innermost open layer only', async () => {
		const page = windowEscapes();
		const modal = layer();
		const menu = layer();
		const { fieldKeys } = mountLayers(modal, menu);

		await escape();
		expect([modal.presses, menu.presses]).toEqual([0, 1]);
		await escape();
		expect([modal.presses, menu.presses]).toEqual([1, 1]);
		// Neither press reached the focused field or the page.
		expect(fieldKeys).toEqual([]);
		expect(page).toEqual([]);

		// Nothing is open: the next press is the page's again.
		await escape();
		expect([modal.presses, menu.presses]).toEqual([1, 1]);
		expect(fieldKeys).toEqual(['Escape']);
		expect(page).toEqual([{ prevented: false }]);
	});

	it('lets a declined press through to the page, not to the layer underneath', async () => {
		const page = windowEscapes();
		const modal = layer();
		const zen = layer({ declines: true });
		const { fieldKeys } = mountLayers(modal, zen);

		await escape();
		expect([modal.presses, zen.presses]).toEqual([0, 1]);
		expect(zen.open.value).toBe(true);
		expect(fieldKeys).toEqual(['Escape']);
		expect(page).toEqual([{ prevented: false }]);
	});

	it('leaves a base layer for last, whenever it opened', async () => {
		const zen = layer({ base: true });
		const dialog = layer();
		// The base layer opens after the dialog and still sits underneath it.
		mountLayers(dialog, zen);

		await escape();
		expect([dialog.presses, zen.presses]).toEqual([1, 0]);
		await escape();
		expect([dialog.presses, zen.presses]).toEqual([1, 1]);
	});

	it('hands Escape back to the page when an open layer unmounts', async () => {
		const page = windowEscapes();
		const menu = layer();
		const { wrapper, fieldKeys } = mountLayers(menu);

		// Unmounted while still open, as a route change tears a menu down.
		wrapper.unmount();
		await escape();
		expect(menu.presses).toBe(0);
		expect(page).toEqual([{ prevented: false }]);
		// The field went with the page, so the press went to the body.
		expect(fieldKeys).toEqual([]);
	});
});
