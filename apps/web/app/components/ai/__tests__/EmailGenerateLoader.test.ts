/**
 * The hosts mount the generator through this loader: it shows a placeholder
 * at once while the panel's chunk loads, then the panel with the host's props,
 * its secondary action and its result handed through. A chunk that does not
 * arrive is reported in the panel's place, with a way to ask again.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import EmailGenerateLoader from '../EmailGenerateLoader.vue';
import type * as Entry from '~/lib/emailGenerationEntry';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const loadEmailGeneratePanel = vi.hoisted(() => vi.fn<() => Promise<Component>>());
vi.mock('~/lib/emailGenerationEntry', async (importOriginal) => ({
	...(await importOriginal<typeof Entry>()),
	loadEmailGeneratePanel,
}));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	loadEmailGeneratePanel.mockReset();
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
	return mount(EmailGenerateLoader, {
		props: { kind: 'template', defaultLanguage: 'de' },
		slots: { secondary: '<button data-testid="back">Back</button>' },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiSpinner: { template: '<span data-testid="spinner" />' },
				UiButton: { template: '<button type="button"><slot /></button>' },
			},
		},
	});
}

const LOADING = '[data-testid="email-generate-loading"]';
const FAILED = '[data-testid="email-generate-load-failed"]';
const PANEL = '[data-testid="panel"]';

describe('EmailGenerateLoader', () => {
	it('shows the placeholder until the panel has loaded, then the panel in its place', async () => {
		let resolvePanel!: (component: Component) => void;
		loadEmailGeneratePanel.mockReturnValue(new Promise((resolve) => (resolvePanel = resolve)));
		const wrapper = mountLoader();
		expect(wrapper.find(LOADING).exists()).toBe(true);
		expect(wrapper.find(PANEL).exists()).toBe(false);

		resolvePanel(PanelStub);
		await flushPromises();

		expect(wrapper.find(LOADING).exists()).toBe(false);
		const panel = wrapper.get(PANEL);
		expect(panel.attributes('data-kind')).toBe('template');
		expect(panel.attributes('data-lang')).toBe('de');
		expect(panel.find('[data-testid="back"]').exists()).toBe(true);
	});

	it('hands the created draft to the host', async () => {
		loadEmailGeneratePanel.mockResolvedValue(PanelStub);
		const wrapper = mountLoader();
		await flushPromises();

		await wrapper.get('[data-testid="finish"]').trigger('click');

		expect(wrapper.emitted('created')).toEqual([[{ kind: 'template', templateId: 't1' }]]);
	});

	it("says so when the panel cannot be loaded, and keeps the host's way out", async () => {
		loadEmailGeneratePanel.mockRejectedValue(
			new TypeError('Failed to fetch dynamically imported module')
		);
		const wrapper = mountLoader();
		await flushPromises();

		expect(wrapper.find(LOADING).exists()).toBe(false);
		expect(wrapper.find(PANEL).exists()).toBe(false);
		const failed = wrapper.get(FAILED);
		expect(failed.attributes('role')).toBe('alert');
		expect(failed.text()).toContain("Couldn't load AI drafting");
		expect(failed.find('[data-testid="back"]').exists()).toBe(true);
	});

	it('asks again on Try again and shows the panel once it arrives', async () => {
		loadEmailGeneratePanel.mockRejectedValueOnce(new TypeError('offline'));
		const wrapper = mountLoader();
		await flushPromises();

		let resolvePanel!: (component: Component) => void;
		loadEmailGeneratePanel.mockReturnValueOnce(new Promise((resolve) => (resolvePanel = resolve)));
		await wrapper.get('[data-testid="email-generate-retry"]').trigger('click');

		expect(wrapper.find(FAILED).exists()).toBe(false);
		expect(wrapper.find(LOADING).exists()).toBe(true);

		resolvePanel(PanelStub);
		await flushPromises();

		expect(loadEmailGeneratePanel).toHaveBeenCalledTimes(2);
		expect(wrapper.find(PANEL).exists()).toBe(true);
	});

	it('reports a second failure the same way', async () => {
		loadEmailGeneratePanel.mockRejectedValue(new TypeError('offline'));
		const wrapper = mountLoader();
		await flushPromises();

		await wrapper.get('[data-testid="email-generate-retry"]').trigger('click');
		await flushPromises();

		expect(loadEmailGeneratePanel).toHaveBeenCalledTimes(2);
		expect(wrapper.find(FAILED).exists()).toBe(true);
	});
});
