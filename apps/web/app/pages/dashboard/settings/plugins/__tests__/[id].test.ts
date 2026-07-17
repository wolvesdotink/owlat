// @vitest-environment happy-dom
/**
 * Plugin settings detail page ([id].vue) — page-level behaviour the pure form
 * helpers cannot cover: the orphaned-plugin "Clear residual settings" action is
 * confirmation-gated, so the destructive reset mutation never fires on a single
 * click.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

const routeId = ref('policy-pack');

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['mail:read']),
				flag: Object.freeze({ default: false }),
				settingsSchema: Object.freeze([
					Object.freeze({
						kind: 'string',
						key: 'endpoint',
						label: 'Endpoint',
						default: 'https://api.test',
					}),
				]),
			}),
		}),
	]),
}));

import PluginDetailPage from '../[id].vue';

const overview = ref<{
	plugins: Array<Record<string, unknown>>;
	orphaned: Array<{ flagKey: string; pluginId: string }>;
}>({ plugins: [], orphaned: [] });

const setPluginSettings = vi.fn();
const resetPluginSettings = vi.fn();
const showToast = vi.fn();
let operationCall = 0;

beforeEach(() => {
	routeId.value = 'policy-pack';
	overview.value = { plugins: [], orphaned: [] };
	operationCall = 0;
	setPluginSettings.mockReset();
	resetPluginSettings.mockReset();
	showToast.mockReset();
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRoute', () => ({
		params: {
			get id() {
				return routeId.value;
			},
		},
	}));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: overview,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	// Two operations are set up in declaration order: setPluginSettings, then
	// resetPluginSettings.
	vi.stubGlobal('useBackendOperation', () => {
		const run = operationCall++ === 0 ? setPluginSettings : resetPluginSettings;
		return { run, isLoading: ref(false) };
	});
});

const passthroughStub = { template: '<div><slot name="header"/><slot/></div>' };
const emptyStateStub = {
	props: ['icon', 'title', 'description'],
	template: '<div><h3>{{ title }}</h3><p>{{ description }}</p><slot/></div>',
};
const confirmationStub = {
	props: ['open', 'title', 'confirmText'],
	emits: ['confirm', 'update:open'],
	template:
		'<div v-if="open" data-testid="confirmation"><h2>{{ title }}</h2><button data-testid="confirm" @click="$emit(\'confirm\')">{{ confirmText }}</button></div>',
};
const buttonStub = { template: '<button v-bind="$attrs"><slot/></button>' };

function mountPage() {
	return mount(PluginDetailPage, {
		global: {
			stubs: {
				UiQueryBoundary: passthroughStub,
				UiCard: passthroughStub,
				UiEmptyState: emptyStateStub,
				UiConfirmationDialog: confirmationStub,
				UiButton: buttonStub,
				UiBadge: true,
				UiIconBox: true,
				Icon: true,
				NuxtLink: true,
			},
		},
	});
}

function clickButtonByText(wrapper: ReturnType<typeof mountPage>, text: string) {
	const button = wrapper.findAll('button').find((b) => b.text().includes(text));
	if (!button) throw new Error(`No button with text "${text}"`);
	return button.trigger('click');
}

describe('plugin detail — orphaned clear is confirmation-gated', () => {
	beforeEach(() => {
		// An id present as orphaned residue but absent from the composition ⇒ no
		// manifest ⇒ the purge-only orphan card renders.
		routeId.value = 'removed-pack';
		overview.value = {
			plugins: [],
			orphaned: [{ flagKey: 'plugin.removed-pack', pluginId: 'removed-pack' }],
		};
	});

	it('does not reset until the confirmation dialog is confirmed', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('no longer installed');

		await clickButtonByText(wrapper, 'Clear residual settings');
		// The mutation must NOT have fired on the first click.
		expect(resetPluginSettings).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="confirmation"]').exists()).toBe(true);

		await wrapper.find('[data-testid="confirm"]').trigger('click');
		await flushPromises();
		expect(resetPluginSettings).toHaveBeenCalledWith({ pluginId: 'removed-pack' });
	});
});
