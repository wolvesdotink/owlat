// @vitest-environment happy-dom
/**
 * THE CONFIRM BUTTON IS A BUTTON, NOT A HAND-COPIED RECIPE.
 *
 * It used to be a raw `<button>` carrying an inlined, and wrong, copy of `.btn`
 * — `rounded-lg px-4` against the design system's `rounded-full px-5`, so the
 * confirm button was visibly a different shape from the Cancel button beside it
 * — plus a per-variant fill: terracotta for `default` and solid gold for
 * `warning`, both of which DESIGN-LANGUAGE.md forbids (§1 "brand terracotta is
 * explicitly not a button fill"; §4 semantic colours are text and hairline
 * tints, not fills).
 *
 * What this pins is the mapping onto UiButton's variants, because that is the
 * only thing standing between the dialog and a fourth hand-written recipe:
 * danger → `.btn-danger` (the one sanctioned solid danger fill), everything
 * else → the monochrome `.btn-primary`. The icon disc keeps its tint.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import ConfirmationDialog from '../components/ui/ConfirmationDialog.vue';
import { createUiI18n } from './i18n';

/** UiModal and UiButton are app-level globals; the layer test needs markers. */
const ModalStub = defineComponent({
	props: { open: Boolean },
	setup:
		(props, { slots }) =>
		() =>
			props.open
				? h('div', [
						h('div', slots['default']?.()),
						h('div', { class: 'footer' }, slots['footer']?.()),
					])
				: null,
});

const ButtonStub = defineComponent({
	props: { variant: String, loading: Boolean },
	setup:
		(props, { slots }) =>
		() =>
			h(
				'button',
				{
					class: 'ui-button',
					'data-variant': props.variant,
					'data-loading': String(props.loading),
				},
				[slots['iconLeft']?.(), slots['default']?.()]
			),
});

function mountDialog(props: Record<string, unknown> = {}) {
	return mount(ConfirmationDialog, {
		props: { open: true, ...props },
		global: {
			plugins: [createUiI18n()],
			stubs: { UiModal: ModalStub, UiButton: ButtonStub, Icon: true },
		},
	});
}

const confirm = (w: ReturnType<typeof mountDialog>) => w.findAll('.footer .ui-button')[1];

describe('ConfirmationDialog — confirm button', () => {
	it('renders both footer actions through UiButton', () => {
		const w = mountDialog();

		expect(w.findAll('.footer .ui-button')).toHaveLength(2);
		// No raw button left carrying a hand-written `.btn` lookalike.
		expect(w.find('.footer button:not(.ui-button)').exists()).toBe(false);
	});

	it('uses the sanctioned danger fill for the danger variant', () => {
		expect(confirm(mountDialog({ variant: 'danger' }))?.attributes('data-variant')).toBe('danger');
	});

	it('uses the monochrome primary for default and warning, never a colour fill', () => {
		expect(confirm(mountDialog())?.attributes('data-variant')).toBe('primary');
		expect(confirm(mountDialog({ variant: 'warning' }))?.attributes('data-variant')).toBe(
			'primary'
		);
	});

	it('hands the pending state to UiButton instead of a second spinner recipe', () => {
		const w = mountDialog({ isLoading: true });

		expect(confirm(w)?.attributes('data-loading')).toBe('true');
		expect(confirm(w)?.text()).toContain('Please wait');
	});

	it('keeps the icon disc a tint, which the design language allows', () => {
		const disc = mountDialog({ variant: 'danger' }).find('.rounded-full');

		expect(disc.classes()).toEqual(expect.arrayContaining(['bg-error/10', 'text-error']));
	});
});
