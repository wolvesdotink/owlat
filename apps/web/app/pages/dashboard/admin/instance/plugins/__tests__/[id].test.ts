// @vitest-environment happy-dom
/**
 * Plugin settings detail page ([id].vue) — page-level behaviour the pure form
 * helpers cannot cover:
 *
 *  - the orphaned-plugin "Clear residual settings" action is confirmation-gated,
 *    so the destructive reset mutation never fires on a single click; and
 *  - a save seeds the form synchronously from the mutation's returned redacted
 *    state, so an edit typed after the save survives a later live-query re-emit.
 *
 * ACCESS CONTROL LIVES ON THE ROUTE. The overview is an adminQuery and the page
 * declares `middleware: ['auth', 'admin']`, which waits for the role and redirects
 * a non-admin to /dashboard before the page renders (the app is `ssr: false`, so it
 * always runs). The page therefore has no editor reader to skip the query for and
 * no in-template "Admins only" card to show one — it used to carry both,
 * unreachably. app/__tests__/adminGatingParity.test.ts is what fails if the
 * middleware declaration ever goes missing.
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
// The reactive args factory the page passes to the overview query: `{}` for an
// Captured so a test can prove it never answers `'skip'`.
let overviewQueryArgs: (() => unknown) | undefined;

beforeEach(() => {
	routeId.value = 'policy-pack';
	overview.value = { plugins: [], orphaned: [] };
	operationCall = 0;
	overviewQueryArgs = undefined;
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
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: (() => unknown) | undefined) => {
		overviewQueryArgs = typeof args === 'function' ? args : undefined;
		return {
			data: overview,
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		};
	});
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

	it('reports a purge, not a reset-to-defaults, on the orphan path', async () => {
		resetPluginSettings.mockResolvedValue({ values: {}, secretsSet: {} });
		const wrapper = mountPage();
		await clickButtonByText(wrapper, 'Clear residual settings');
		await wrapper.find('[data-testid="confirm"]').trigger('click');
		await flushPromises();
		// The orphan copy matches the index page ("Cleared residual settings for X."),
		// not the in-form "reset to defaults" (there are no defaults — the plugin is gone).
		expect(showToast).toHaveBeenCalledWith('Cleared residual settings for removed-pack.');
	});
});

function installedEntry(endpoint: string) {
	return {
		pluginId: 'policy-pack',
		packageName: '@example/policy-pack',
		version: '1.0.0',
		flagKey: 'plugin.policy-pack',
		enabled: true,
		hasSettings: true,
		capabilities: [{ capability: 'mail:read', granted: true }],
		values: { endpoint },
		secretsSet: {},
	};
}

describe('plugin detail — save seeds from the returned redacted state', () => {
	beforeEach(() => {
		overview.value = { plugins: [installedEntry('https://api.test')], orphaned: [] };
	});

	it('keeps an edit typed after save when a stale live-query value re-emits', async () => {
		setPluginSettings.mockResolvedValue({
			values: { endpoint: 'https://saved.example' },
			secretsSet: {},
		});
		const wrapper = mountPage();

		// Edit and save.
		await wrapper.get('input[type="text"]').setValue('https://saved.example');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(setPluginSettings).toHaveBeenCalledWith({
			pluginId: 'policy-pack',
			values: { endpoint: 'https://saved.example' },
		});

		// The operator immediately types another edit after the save resolved.
		await wrapper.get('input[type="text"]').setValue('https://later.example');

		// A stale live-query emission for the same plugin id arrives afterwards
		// (a fresh entry object, so the watch fires). It must NOT re-seed the form.
		overview.value = { plugins: [installedEntry('https://saved.example')], orphaned: [] };
		await flushPromises();

		expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe(
			'https://later.example'
		);
	});
});

describe('plugin detail — gated by the route, not by the template', () => {
	beforeEach(() => {
		overview.value = { plugins: [installedEntry('https://api.test')], orphaned: [] };
	});

	it('runs the overview query and renders the surface for the admin who reached it', () => {
		const wrapper = mountPage();
		expect(wrapper.find('input[type="text"]').exists()).toBe(true);
		expect(overviewQueryArgs?.()).toEqual({});
	});

	it('never answers the query args with a skip', () => {
		// The `'skip'` branch existed only for the editor the middleware now turns
		// away; left behind, it would be an unreachable condition that could only
		// ever strand an admin on a page with no form.
		mountPage();
		expect(overviewQueryArgs?.()).not.toBe('skip');
	});

	it('shows no "Admins only" card to the only role that can read the page', () => {
		const wrapper = mountPage();
		expect(wrapper.text()).not.toContain('Admins only');
	});
});
