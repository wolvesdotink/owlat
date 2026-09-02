// @vitest-environment happy-dom
/**
 * The empty state is the landing ladder or it is nothing.
 *
 * Two of these assertions exist because the version this replaced failed them
 * in production markup, not in theory:
 *  - the title was a `<p>`, so a page whose entire content is its empty state
 *    had no heading at all for a screen-reader heading walk to find;
 *  - only `#action` was rendered, so every call site that passed its button as
 *    the component's children (deliverability, plugin detail) shipped an empty
 *    state with no way out of it.
 *
 * The rest pin the structure the design language asks for — eyebrow, one
 * heading, one lead, one action, and no 56px filled icon disc.
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, type App, type Plugin, type VNodeChild } from 'vue';
import EmptyState from '../components/ui/EmptyState.vue';
import { createUiI18n, mountUi } from './i18n';

/** `UiButton` is an app-level global; the layer test only needs a marker. */
const ButtonStub = defineComponent({
	name: 'UiButton',
	emits: ['click'],
	setup:
		(_, { slots, emit }) =>
		() =>
			h('button', { 'data-stub': 'ui-button', onClick: () => emit('click') }, slots['default']?.()),
});

/**
 * The real catalogs plus the one app-level global this component reaches for.
 * `mountUi` installs a single plugin, so the two travel together.
 */
const uiEnvironment: Plugin = {
	install(app: App) {
		app.use(createUiI18n('en'));
		app.component('UiButton', ButtonStub);
	},
};

type EmptyStateProps = InstanceType<typeof EmptyState>['$props'];

function mountEmptyState(props: EmptyStateProps, slots?: Record<string, () => VNodeChild>) {
	return mountUi({ setup: () => () => h(EmptyState, props, slots) }, {}, 'en', uiEnvironment);
}

describe('UiEmptyState — the landing ladder', () => {
	it('renders the title as a real heading a heading walk can find', () => {
		const { el, unmount } = mountEmptyState({ title: 'No webhooks yet' });

		const heading = el.querySelector('h2');
		expect(heading?.textContent?.trim()).toBe('No webhooks yet');
		// …and not as the bolded paragraph it used to be.
		expect(el.querySelector('p')?.textContent).not.toContain('No webhooks yet');

		unmount();
	});

	it('honours headingLevel so it nests under a section that already has one', () => {
		const { el, unmount } = mountEmptyState({ title: 'No rows', headingLevel: 3 });

		expect(el.querySelector('h3')?.textContent?.trim()).toBe('No rows');
		expect(el.querySelector('h2')).toBeNull();

		unmount();
	});

	it('leads with an eyebrow micro-label, defaulted per variant', () => {
		const empty = mountEmptyState({ title: 'No webhooks yet' });
		expect(empty.el.querySelector('.lp-eyebrow')?.textContent?.trim()).toBe('Nothing here yet');
		empty.unmount();

		const filtered = mountEmptyState({ title: 'No open conversations', variant: 'no-results' });
		expect(filtered.el.querySelector('.lp-eyebrow')?.textContent?.trim()).toBe('No matches');
		filtered.unmount();
	});

	it('lets a caller word its own eyebrow', () => {
		const { el, unmount } = mountEmptyState({ title: 'All clear', eyebrow: 'Quarantine' });

		expect(el.querySelector('.lp-eyebrow')?.textContent?.trim()).toBe('Quarantine');

		unmount();
	});

	it('renders one secondary lead sentence, and none when there is none', () => {
		const withLead = mountEmptyState({
			title: 'No webhooks yet',
			description: 'Owlat calls your endpoint on every delivery event.',
		});
		const leads = [...withLead.el.querySelectorAll('p')].filter(
			(p) => !p.classList.contains('lp-eyebrow')
		);
		expect(leads).toHaveLength(1);
		expect(leads[0]?.textContent?.trim()).toBe(
			'Owlat calls your endpoint on every delivery event.'
		);
		withLead.unmount();

		const bare = mountEmptyState({ title: 'No webhooks yet' });
		expect(
			[...bare.el.querySelectorAll('p')].filter((p) => !p.classList.contains('lp-eyebrow'))
		).toHaveLength(0);
		bare.unmount();
	});

	it('keeps the icon as a hairline glyph in the eyebrow, never a filled disc', () => {
		const { el, unmount } = mountEmptyState({ title: 'No domains', icon: 'lucide:globe' });

		const glyph = el.querySelector('.lp-eyebrow i');
		expect(glyph).not.toBeNull();
		// The disc was a `UiIconBox` with a `size="xl"` (56px) surface fill.
		expect(el.innerHTML).not.toContain('IconBox');
		expect(el.querySelector('[class*="rounded-full"]')).toBeNull();

		unmount();
	});

	it('renders the action passed as children, not only through #action', () => {
		const viaSlot = mountEmptyState({ title: 'No data' }, { action: () => h('button', 'Add') });
		expect(viaSlot.el.textContent).toContain('Add');
		viaSlot.unmount();

		const viaChildren = mountEmptyState(
			{ title: 'No data' },
			{ default: () => h('button', 'Configure') }
		);
		expect(viaChildren.el.textContent).toContain('Configure');
		viaChildren.unmount();
	});

	it('offers a clear control on no-results when @clear is wired', () => {
		let cleared = 0;
		const { el, unmount } = mountEmptyState({
			title: 'No open conversations',
			variant: 'no-results',
			onClear: () => {
				cleared += 1;
			},
		});

		const button = el.querySelector<HTMLButtonElement>('[data-stub="ui-button"]');
		expect(button?.textContent?.trim()).toBe('Clear filters');
		button?.click();
		expect(cleared).toBe(1);

		unmount();
	});

	it('never shows the clear control on the empty variant or without a listener', () => {
		const unwired = mountEmptyState({ title: 'No matches', variant: 'no-results' });
		expect(unwired.el.querySelector('[data-stub="ui-button"]')).toBeNull();
		unwired.unmount();

		const created = mountEmptyState({ title: 'Nothing yet', onClear: () => {} });
		expect(created.el.querySelector('[data-stub="ui-button"]')).toBeNull();
		created.unmount();
	});

	it('lets #action win over the built-in clear control', () => {
		const { el, unmount } = mountEmptyState(
			{ title: 'No matches', variant: 'no-results', onClear: () => {} },
			{ action: () => h('button', { 'data-testid': 'own' }, 'Reset search') }
		);

		expect(el.querySelector('[data-testid="own"]')).not.toBeNull();
		expect(el.querySelector('[data-stub="ui-button"]')).toBeNull();

		unmount();
	});

	it('gives the transient no-results state less air than a true empty', () => {
		const empty = mountEmptyState({ title: 'Nothing yet' });
		expect(empty.el.firstElementChild?.className).toContain('py-16');
		empty.unmount();

		const filtered = mountEmptyState({ title: 'No matches', variant: 'no-results' });
		expect(filtered.el.firstElementChild?.className).toContain('py-12');
		filtered.unmount();
	});
});
