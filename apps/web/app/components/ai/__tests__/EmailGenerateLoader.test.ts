/**
 * The hosts mount the generator through this loader: it shows a placeholder
 * at once while the panel's chunk loads, then the panel with the host's props,
 * its secondary action and its result handed through.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineAsyncComponent, defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import EmailGenerateLoader from '../EmailGenerateLoader.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const PanelStub = defineComponent({
	props: { kind: String, defaultLanguage: String },
	emits: ['created'],
	setup(props, { emit, slots }) {
		return () =>
			h(
				'form',
				{ 'data-testid': 'panel', 'data-kind': props.kind, 'data-lang': props.defaultLanguage },
				[
					slots['secondary']?.({ isGenerating: false }),
					h('button', {
						'data-testid': 'finish',
						type: 'button',
						onClick: () => emit('created', { kind: 'template', templateId: 't1' }),
					}),
				]
			);
	},
});

function mountLoader() {
	let resolvePanel!: (component: typeof PanelStub) => void;
	const chunk = new Promise<typeof PanelStub>((resolve) => (resolvePanel = resolve));
	const wrapper = mount(EmailGenerateLoader, {
		props: { kind: 'template', defaultLanguage: 'de' },
		slots: { secondary: '<button data-testid="back">Back</button>' },
		global: {
			plugins: [createTestI18n()],
			components: { LazyAiEmailGeneratePanel: defineAsyncComponent(() => chunk) },
			stubs: { UiSpinner: { template: '<span data-testid="spinner" />' } },
		},
	});
	return { wrapper, resolvePanel };
}

describe('EmailGenerateLoader', () => {
	it('shows the placeholder until the panel has loaded, then the panel in its place', async () => {
		const { wrapper, resolvePanel } = mountLoader();
		expect(wrapper.find('[data-testid="email-generate-loading"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="panel"]').exists()).toBe(false);

		resolvePanel(PanelStub);
		await flushPromises();

		expect(wrapper.find('[data-testid="email-generate-loading"]').exists()).toBe(false);
		const panel = wrapper.get('[data-testid="panel"]');
		expect(panel.attributes('data-kind')).toBe('template');
		expect(panel.attributes('data-lang')).toBe('de');
		expect(panel.find('[data-testid="back"]').exists()).toBe(true);
	});

	it('hands the created draft to the host', async () => {
		const { wrapper, resolvePanel } = mountLoader();
		resolvePanel(PanelStub);
		await flushPromises();

		await wrapper.get('[data-testid="finish"]').trigger('click');

		expect(wrapper.emitted('created')).toEqual([[{ kind: 'template', templateId: 't1' }]]);
	});
});
